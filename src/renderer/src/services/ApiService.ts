import Logger from '@renderer/config/logger'
import { getOpenAIWebSearchParams, isOpenAIWebSearch } from '@renderer/config/models'
import {
  SEARCH_SUMMARY_PROMPT,
  SEARCH_SUMMARY_PROMPT_KNOWLEDGE_ONLY,
  SEARCH_SUMMARY_PROMPT_WEB_ONLY
} from '@renderer/config/prompts'
import i18n from '@renderer/i18n'
import {
  Assistant,
  ExternalToolResult,
  KnowledgeReference,
  MCPTool,
  Model,
  Provider,
  Suggestion,
  WebSearchResponse,
  WebSearchSource
} from '@renderer/types'
import { type Chunk, ChunkType } from '@renderer/types/chunk'
import { Message } from '@renderer/types/newMessage'
import { isAbortError } from '@renderer/utils/error'
import { extractInfoFromXML, ExtractResults } from '@renderer/utils/extract'
import { getKnowledgeBaseIds, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { message } from 'antd'
import { findLast, isEmpty } from 'lodash'

import AiProvider from '../providers/AiProvider'
import {
  getAssistantProvider,
  getDefaultModel,
  getProviderByModel,
  getTopNamingModel,
  getTranslateModel
} from './AssistantService'
import { getDefaultAssistant } from './AssistantService'
import { processKnowledgeSearch } from './KnowledgeService'
import { filterContextMessages, filterMessages, filterUsefulMessages } from './MessagesService'
import WebSearchService from './WebSearchService'

// TODO：考虑拆开
async function fetchExternalTool(
  lastUserMessage: Message,
  assistant: Assistant,
  onChunkReceived: (chunk: Chunk) => void,
  lastAnswer?: Message
): Promise<ExternalToolResult> {
  // 可能会有重复？
  const knowledgeBaseIds = getKnowledgeBaseIds(lastUserMessage)
  const hasKnowledgeBase = !isEmpty(knowledgeBaseIds)
  const knowledgeRecognition = assistant.knowledgeRecognition || 'on'
  const webSearchProvider = WebSearchService.getWebSearchProvider(assistant.webSearchProviderId)

  const shouldWebSearch = !!assistant.webSearchProviderId && webSearchProvider !== null
  const shouldKnowledgeSearch = hasKnowledgeBase

  // 在工具链开始时发送进度通知
  const willUseTools = shouldWebSearch || shouldKnowledgeSearch
  if (willUseTools) {
    onChunkReceived({ type: ChunkType.EXTERNEL_TOOL_IN_PROGRESS })
  }

  // --- Keyword/Question Extraction Function ---
  const extract = async (): Promise<ExtractResults | undefined> => {
    if (!lastUserMessage) return undefined

    // 根据配置决定是否需要提取
    const needWebExtract = shouldWebSearch
    const needKnowledgeExtract = hasKnowledgeBase && knowledgeRecognition === 'on'

    if (!needWebExtract && !needKnowledgeExtract) return undefined

    let prompt: string
    if (needWebExtract && !needKnowledgeExtract) {
      prompt = SEARCH_SUMMARY_PROMPT_WEB_ONLY
    } else if (!needWebExtract && needKnowledgeExtract) {
      prompt = SEARCH_SUMMARY_PROMPT_KNOWLEDGE_ONLY
    } else {
      prompt = SEARCH_SUMMARY_PROMPT
    }

    const summaryAssistant = getDefaultAssistant()
    summaryAssistant.model = assistant.model || getDefaultModel()
    summaryAssistant.prompt = prompt

    try {
      const keywords = await fetchSearchSummary({
        messages: lastAnswer ? [lastAnswer, lastUserMessage] : [lastUserMessage],
        assistant: summaryAssistant
      })

      if (!keywords) return getFallbackResult()

      const extracted = extractInfoFromXML(keywords)
      // 根据需求过滤结果
      return {
        websearch: needWebExtract ? extracted?.websearch : undefined,
        knowledge: needKnowledgeExtract ? extracted?.knowledge : undefined
      }
    } catch (e: any) {
      console.error('extract error', e)
      if (isAbortError(e)) throw e
      return getFallbackResult()
    }
  }

  const getFallbackResult = (): ExtractResults => {
    const fallbackContent = getMainTextContent(lastUserMessage)
    return {
      websearch: shouldWebSearch ? { question: [fallbackContent || 'search'] } : undefined,
      knowledge: shouldKnowledgeSearch
        ? {
            question: [fallbackContent || 'search'],
            rewrite: fallbackContent
          }
        : undefined
    }
  }

  // --- Web Search Function ---
  const searchTheWeb = async (extractResults: ExtractResults | undefined): Promise<WebSearchResponse | undefined> => {
    if (!shouldWebSearch) return

    // Add check for extractResults existence early
    if (!extractResults?.websearch) {
      console.warn('searchTheWeb called without valid extractResults.websearch')
      return
    }

    if (extractResults.websearch.question[0] === 'not_needed') return

    // Add check for assistant.model before using it
    if (!assistant.model) {
      console.warn('searchTheWeb called without assistant.model')
      return undefined
    }

    // Pass the guaranteed model to the check function
    const webSearchParams = getOpenAIWebSearchParams(assistant, assistant.model)
    if (!isEmpty(webSearchParams) || isOpenAIWebSearch(assistant.model)) {
      return
    }

    try {
      // Use the consolidated processWebsearch function
      WebSearchService.createAbortSignal(lastUserMessage.id)
      return {
        results: await WebSearchService.processWebsearch(webSearchProvider!, extractResults),
        source: WebSearchSource.WEBSEARCH
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      console.error('Web search failed:', error)
      return
    }
  }

  // --- Knowledge Base Search Function ---
  const searchKnowledgeBase = async (
    extractResults: ExtractResults | undefined
  ): Promise<KnowledgeReference[] | undefined> => {
    if (!hasKnowledgeBase) return

    // 知识库搜索条件
    let searchCriteria: { question: string[]; rewrite: string }
    if (knowledgeRecognition === 'off') {
      const directContent = getMainTextContent(lastUserMessage)
      searchCriteria = { question: [directContent || 'search'], rewrite: directContent }
    } else {
      // auto mode
      if (!extractResults?.knowledge) {
        console.warn('searchKnowledgeBase: No valid search criteria in auto mode')
        return
      }
      searchCriteria = extractResults.knowledge
    }

    if (searchCriteria.question[0] === 'not_needed') return

    try {
      const tempExtractResults: ExtractResults = {
        websearch: undefined,
        knowledge: searchCriteria
      }
      // Attempt to get knowledgeBaseIds from the main text block
      // NOTE: This assumes knowledgeBaseIds are ONLY on the main text block
      // NOTE: processKnowledgeSearch needs to handle undefined ids gracefully
      // const mainTextBlock = mainTextBlocks
      //   ?.map((blockId) => store.getState().messageBlocks.entities[blockId])
      //   .find((block) => block?.type === MessageBlockType.MAIN_TEXT) as MainTextMessageBlock | undefined
      return await processKnowledgeSearch(tempExtractResults, knowledgeBaseIds)
    } catch (error) {
      console.error('Knowledge base search failed:', error)
      return
    }
  }

  // --- Execute Extraction and Searches ---
  let extractResults: ExtractResults | undefined

  try {
    // 根据配置决定是否需要提取
    if (shouldWebSearch || hasKnowledgeBase) {
      extractResults = await extract()
      Logger.log('[fetchExternalTool] Extraction results:', extractResults)
    }

    let webSearchResponseFromSearch: WebSearchResponse | undefined
    let knowledgeReferencesFromSearch: KnowledgeReference[] | undefined

    // 并行执行搜索
    if (shouldWebSearch || shouldKnowledgeSearch) {
      ;[webSearchResponseFromSearch, knowledgeReferencesFromSearch] = await Promise.all([
        searchTheWeb(extractResults),
        searchKnowledgeBase(extractResults)
      ])
    }

    // 存储搜索结果
    if (lastUserMessage) {
      if (webSearchResponseFromSearch) {
        window.keyv.set(`web-search-${lastUserMessage.id}`, webSearchResponseFromSearch)
      }
      if (knowledgeReferencesFromSearch) {
        window.keyv.set(`knowledge-search-${lastUserMessage.id}`, knowledgeReferencesFromSearch)
      }
    }

    // 发送工具执行完成通知
    if (willUseTools) {
      onChunkReceived({
        type: ChunkType.EXTERNEL_TOOL_COMPLETE,
        external_tool: {
          webSearch: webSearchResponseFromSearch,
          knowledge: knowledgeReferencesFromSearch
        }
      })
    }

    // Get MCP tools (Fix duplicate declaration)
    let mcpTools: MCPTool[] = [] // Initialize as empty array
    const enabledMCPs = lastUserMessage?.enabledMCPs
    if (enabledMCPs && enabledMCPs.length > 0) {
      try {
        const toolPromises = enabledMCPs.map(async (mcpServer) => {
          const tools = await window.api.mcp.listTools(mcpServer)
          return tools.filter((tool: any) => !mcpServer.disabledTools?.includes(tool.name))
        })
        const results = await Promise.all(toolPromises)
        mcpTools = results.flat() // Flatten the array of arrays
      } catch (toolError) {
        console.error('Error fetching MCP tools:', toolError)
      }
    }

    return { mcpTools }
  } catch (error) {
    if (isAbortError(error)) throw error
    console.error('Tool execution failed:', error)

    // 发送错误状态
    if (willUseTools) {
      onChunkReceived({
        type: ChunkType.EXTERNEL_TOOL_COMPLETE,
        external_tool: {
          webSearch: undefined,
          knowledge: undefined
        }
      })
    }

    return { mcpTools: [] }
  }
}

export async function fetchChatCompletion({
  messages,
  assistant,
  onChunkReceived
}: {
  messages: Message[]
  assistant: Assistant
  onChunkReceived: (chunk: Chunk) => void
  // TODO
  // onChunkStatus: (status: 'searching' | 'processing' | 'success' | 'error') => void
}) {
  console.log('fetchChatCompletion', messages, assistant)

  const provider = getAssistantProvider(assistant)
  const AI = new AiProvider(provider)

  // Make sure that 'Clear Context' works for all scenarios including external tool and normal chat.
  messages = filterContextMessages(messages)

  const lastUserMessage = findLast(messages, (m) => m.role === 'user')
  const lastAnswer = findLast(messages, (m) => m.role === 'assistant')
  if (!lastUserMessage) {
    console.error('fetchChatCompletion returning early: Missing lastUserMessage or lastAnswer')
    return
  }
  // try {
  // NOTE: The search results are NOT added to the messages sent to the AI here.
  // They will be retrieved and used by the messageThunk later to create CitationBlocks.
  const { mcpTools } = await fetchExternalTool(lastUserMessage, assistant, onChunkReceived, lastAnswer)

  const filteredMessages = filterUsefulMessages(messages)

  // --- Call AI Completions ---
  await AI.completions({
    messages: filteredMessages,
    assistant,
    onFilterMessages: () => {},
    onChunk: onChunkReceived,
    mcpTools: mcpTools
  })
}

interface FetchTranslateProps {
  content: string
  assistant: Assistant
  onResponse?: (text: string, isComplete: boolean) => void
}

export async function fetchTranslate({ content, assistant, onResponse }: FetchTranslateProps) {
  const model = getTranslateModel()

  if (!model) {
    throw new Error(i18n.t('error.provider_disabled'))
  }

  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    throw new Error(i18n.t('error.no_api_key'))
  }

  const AI = new AiProvider(provider)

  try {
    return await AI.translate(content, assistant, onResponse)
  } catch (error: any) {
    return ''
  }
}

export async function fetchMessagesSummary({ messages, assistant }: { messages: Message[]; assistant: Assistant }) {
  //优先级, 用户配置的话题命名模型>当前助手的话题命名模型>默认模型
  const model = getTopNamingModel() || assistant.model || getDefaultModel()
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    message.warning(i18n.t('message.error.topic_naming_model_key_missing'))
    return null
  }

  const AI = new AiProvider(provider)

  try {
    const text = await AI.summaries(filterMessages(messages), assistant)
    return text?.replace(/["']/g, '') || null
  } catch (error: any) {
    message.error(i18n.t('message.error.fetchTopicName'))
    return null
  }
}

export async function fetchSearchSummary({ messages, assistant }: { messages: Message[]; assistant: Assistant }) {
  const model = assistant.model || getDefaultModel()
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return null
  }

  const AI = new AiProvider(provider)

  return await AI.summaryForSearch(messages, assistant)
}

export async function fetchGenerate({ prompt, content }: { prompt: string; content: string }): Promise<string> {
  const model = getDefaultModel()
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return ''
  }

  const AI = new AiProvider(provider)

  try {
    return await AI.generateText({ prompt, content })
  } catch (error: any) {
    return ''
  }
}

export async function fetchSuggestions({
  messages,
  assistant
}: {
  messages: Message[]
  assistant: Assistant
}): Promise<Suggestion[]> {
  const model = assistant.model
  if (!model || model.id.endsWith('global')) {
    return []
  }

  const provider = getAssistantProvider(assistant)
  const AI = new AiProvider(provider)

  try {
    return await AI.suggestions(filterMessages(messages), assistant)
  } catch (error: any) {
    return []
  }
}

function hasApiKey(provider: Provider) {
  if (!provider) return false
  if (provider.id === 'ollama' || provider.id === 'lmstudio') return true
  return !isEmpty(provider.apiKey)
}

export async function fetchModels(provider: Provider) {
  const AI = new AiProvider(provider)

  try {
    return await AI.models()
  } catch (error) {
    return []
  }
}

export const formatApiKeys = (value: string) => {
  return value.replaceAll('，', ',').replaceAll(' ', ',').replaceAll(' ', '').replaceAll('\n', ',')
}

export function checkApiProvider(provider: Provider): {
  valid: boolean
  error: Error | null
} {
  const key = 'api-check'
  const style = { marginTop: '3vh' }

  if (provider.id !== 'ollama' && provider.id !== 'lmstudio') {
    if (!provider.apiKey) {
      window.message.error({ content: i18n.t('message.error.enter.api.key'), key, style })
      return {
        valid: false,
        error: new Error(i18n.t('message.error.enter.api.key'))
      }
    }
  }

  if (!provider.apiHost) {
    window.message.error({ content: i18n.t('message.error.enter.api.host'), key, style })
    return {
      valid: false,
      error: new Error(i18n.t('message.error.enter.api.host'))
    }
  }

  if (isEmpty(provider.models)) {
    window.message.error({ content: i18n.t('message.error.enter.model'), key, style })
    return {
      valid: false,
      error: new Error(i18n.t('message.error.enter.model'))
    }
  }

  return {
    valid: true,
    error: null
  }
}

export async function checkApi(provider: Provider, model: Model): Promise<{ valid: boolean; error: Error | null }> {
  const validation = checkApiProvider(provider)
  if (!validation.valid) {
    return {
      valid: validation.valid,
      error: validation.error
    }
  }

  const ai = new AiProvider(provider)

  // Try streaming check first
  const result = await ai.check(model, true)

  if (result.valid && !result.error) {
    return result
  }

  // 不应该假设错误由流式引发。多次发起检测请求可能触发429，掩盖了真正的问题。
  // 但这里错误类型做的很粗糙，暂时先这样
  if (result.error && result.error.message.includes('stream')) {
    return ai.check(model, false)
  } else {
    return result
  }
}
