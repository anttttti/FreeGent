// globals.d.ts — ambient declarations for the window-bridge surface (AUTO-GENERATED
// during the ESM migration; regenerate when bridges change). The hybrid module model
// resolves cross-file references through globalThis at runtime (see AGENTS.md).
// Declaring the bridge surface turns free-variable TYPOS into compile errors while
// accepting the architecture. Types are `any` until call sites import directly.

declare global {
    // CDN globals loaded before the module graph (katex, hljs, DOMPurify via <script> tags)
    var DOMPurify: any;
    var katex: any;
    var hljs: any;
    // ── bridged by chat-attachments.ts ──
    var addImageAttachment: any;
    var clearImageAttachments: any;
    var addFileAttachment: any;
    var restoreFileAttachment: any;
    var getPendingAttachments: any;
    var setupChatDropZone: any;
    var _guessMime: any;
    var _fileIcon: any;
    var _fmtSz: any;
    var _LANG_MAP: any;
    var _audioFmt: any;
    // ── bridged by agent-core.ts ──
    var _htmlToMarkdown: any;
    var _readInputText: any;
    var _setInputText: any;
    var _updateSendBtnVisibility: () => void;
    var agentSend: (container?: HTMLElement | null) => Promise<void>;
    var runAgentTurn: (prompt: string, container?: HTMLElement | null, session?: any, opts?: { placeholder?: any }) => Promise<string>;
    var autoResizeTextarea: any;
    var clearCheckpoints: any;
    var createNewChat: () => void;
    var handleSendButton: () => void;
    var newChat: () => void;
    var rerunCheckpoint: any;
    var rewindToCheckpoint: any;
    var retryLastTurn: (container?: HTMLElement | null) => Promise<void>;
    var setInputState: (enabled: boolean) => void;
    var showCheckpointDiff: any;
    var stopAfterStep: () => void;
    var stopNow: () => void;
    var _startEditUserMsg: any;
    var _onQueueDequeue: ((msg: any) => void) | undefined;
    // ── bridged by runner.ts ──
    var runnerInterrupt: any;
    var runnerPause: () => void;
    var runnerRestart: () => void;
    var runnerResume: () => void;
    var runnerSendUnblock: () => void;
    var runnerStart: () => void;
    var runnerStop: () => void;
    var runnerToggle: () => void;
    var initRunner: () => void;
    var isRunnerRunning: () => boolean;
    // ── bridged by ast.ts ──
    var _astFormatResults: any;
    var _astQueryContent: any;
    // ── bridged by autopilot.ts ──
    var isAutopilotRunning: any;
    var stopAutopilot: any;
    var toggleAutopilot: any;
    // ── bridged by bootstrap-jsdom.ts ──
    var AbortController: any;
    var AbortSignal: any;
    var alert: any;
    var confirm: any;
    var fetch: any;
    var indexedDB: any;
    var marked: any;
    // ── bridged by chat-render.ts ──
    var appendMessage: any;
    var cleanResponse: any;
    var createResponsePlaceholder: any;
    var getMessagesEl: any;
    var initChatEmpty: () => void;
    var _updateChatEmpty: () => void;
    var processImgSlots: any;
    var processFileLinks: any;
    var renderMarkdown: any;
    var scrollBottom: any;
    // ── bridged by chat-state.ts ──
    var autoNameChat: any;
    var closeChatsDropdown: any;
    var deleteCurrentChat: any;
    var focusChatSearch: any;
    var _filterChatsDropdown: any;
    var searchMessages: any;
    var updateRailRecentChats: () => void;
    // ── bridged by init.ts (inside DOMContentLoaded) ──
    var scrollToLatest: any;
    var _updateScrollBtn: any;
    var openMsgSearch: any;
    var closeMsgSearch: any;
    var runMsgSearch: any;
    var msgSearchKeydown: any;
    var msgSearchSelect: any;
    var clearInputDraft: any;
    var _restoreDraft: any;
    var toggleDarkMode: any;
    var getChatList: any;
    var loadChatHistory: any;
    var migrateOldStorage: any;
    var renderChatsDropdown: any;
    var renderHistoryFallback: any;
    var restoreChatMessages: any;
    var saveChatList: any;
    var saveHistory: any;
    var startInlineRenameCurrentChat: any;
    var switchToChat: any;
    var toggleChatsDropdown: any;
    var updateChatMetaLastAt: any;
    var updateChatNameBar: any;
    // ── bridged by config.ts ──
    var ALL_TOOL_NAMES: any;
    var OPT_IN_TOOLS: any;
    var modelSupportsThinking: (provider: string, model: string) => boolean;
    var MAX_STEPS: any;
    var _pyodideImageStore: any;
    var activeSkills: any;
    var agentsContext: any;
    var buildModelCatalogText: any;
    var chatsDropdownOpen: any;
    var disabledRoles: any;
    var enabledTools: any;
    var getMode: () => 'chat' | 'cowork';
    var setMode: (m: 'chat' | 'cowork') => void;
    var isToolActive: (name: string) => boolean;
    var estimateTokens: (obj: any) => number;
    var getActiveMainModelList: any;
    var specHasKey: (spec: string) => boolean;
    var getActiveModel: any;
    var getAgentCompactAt: any;
    var getAgentCompactTokens: any;
    var getAgentConcisePrompts: any;
    var getAgentLeanWorkers: any;
    var getAgentLedger: any;
    var getRunnerMaxConsecutiveFails: any;
    var getRunnerQa: any;
    var getAgentMaxDelegationDepth: any;
    var getAgentMaxReplans: any;
    var getAgentMaxSteps: any;
    var getAgentMaxToolResult: any;
    var getAgentPlanMode: any;
    var getAgentProactiveCompact: any;

    var getAgentPromptTemplate: any;
    var getAgentReviewLogs: any;
    var getAgentRoleModelRouting: any;
    var getAgentToolTruncation: any;
    var getAgentWorkerHistory: any;
    var getAgentWorkerReduce: any;
    var getAllModels: any;
    var getAllModelsForMedia: any;
    var getAstEnabled: any;
    var getAudioModel: any;
    var getBraveKey: any;
    var getCerebrasKey: any;
    var getContextThreshold: any;
    var getContextUsage: () => { used: number; limit: number };
    var getCustomModels: any;
    var getDirectorMaxToolResult: any;
    var getEditReviewEnabled: any;
    var getEffectiveProxy: any;
    var getEnabledModels: any;
    var getEndpointRotation: any;
    var getGeminiKey: any;
    var getGeminiModel: any;
    var getGitEnabled: any;
    var getGithubToken: any;
    var getGroqKey: any;
    var getHFKey: any;
    var getImageModel: any;
    var getIntentValidation: any;
    var getLocalApiProxy: any;
    var getMainModelList: any;
    var getMediaCapableSpec: any;
    var getMinP: any;
    var getMistralKey: any;
    var getMistralModel: any;
    var getNvidiaKey: any;
    var getNvidiaModel: any;
    var getOAIKey: any;
    var getOpenCodeKey: any;
    var getTokenHarborKey: any;
    var getKiloKey: any;
    var getVercelKey: any;
    var getNousKey: any;
    var getOAIContextTokens: any;
    var getOAIModel: any;
    var getOAIUrl: any;
    var getOpenRouterKey: any;
    var getOpenRouterModel: any;
    var getPausedMainModels: any;
    var getPresencePenalty: any;
    var getProvider: any;
    var getQaAcceptanceReview: any;
    var getQaEnabled: any;
    var getQaRegressionGuard: any;
    var getQaReworkLimit: any;
    var getQaTestRunner: any;
    var getRateLimitCooldownMs: any;
    var getRepetitionPenalty: any;
    var getGeoCache: any;
    var prefetchGeoCache: any;
    var getRoleBody: any;
    var getRoleBodyFn: any;
    var setRoleBodyFn: any;
    var getRotationStepN: any;
    var getSandboxProvider: any;
    var getSamplingParams: any;
    var getSearchProvider: any;
    var getSearchProxy: any;
    var getShowNudges: any;
    var getStackExchangeKey: any;
    var getTavilyKey: any;
    var getTemperature: any;
    var getTopK: any;
    var getTopP: any;
    var getThinkingLevel: any;
    var getToolApproval: any;
    var getVideoModel: any;
    var getWorkerThinkingBudget: any;
    var isContextSizeKnown: any;
    var isRoleEnabled: any;
    var loadServerKeys: any;
    var loadCfWorkerKeys: (() => Promise<void>) | undefined;
    var ls: any;
    var parseFrontmatter: any;
    var pyodideStatus: any;
    var runWithPyodide: any;
    var runWithWasm: any;
    var saveAudioModel: any;
    var saveCustomModels: any;
    var saveEnabledModels: any;
    var saveImageModel: any;
    var saveMainModelList: any;
    var savePausedMainModels: any;
    var saveSamplingSetting: any;
    var saveVideoModel: any;
    var hideBuiltinModel: (key: string) => void;
    var unhideBuiltinModel: (key: string) => void;
    var setDisabledTools: any;
    var setIntentValidation: any;
    var setRoleBody: any;
    var skillsRegistry: any;
    var startPyodide: any;
    var thinkingLevelBudget: any;
    var updateModelLabel: any;
    var updatePyodideStatusEl: any;
    var updateTokenLabel: any;
    var updateTokenLabelAccurate: any;
    // ── bridged by convo-log.ts ──
    var _updateLogBadge: any;
    var conversationLog: any;
    var convoLogTurn: any;
    var esc: any;
    var exportChat: any;
    var exportChatMarkdown: any;
    var importChat: any;
    var loadChatLog: any;
    var pruneConvoLogFrom: any;
    // ── bridged by deep-research.ts ──
    var extractRelevant: any;
    var runDeepResearch: any;
    // ── bridged by editor.ts ──
    var createEditor: any;
    var setEditorContent: any;
    // ── bridged by headless-runner.ts ──
    var _fgHeadless: boolean | undefined;
    var fgPipPackages: any;
    var fgTargetContainer: any;
    var nativeExec: any;
    var hasLocalFolder: any;
    // ── bridged by history-util.ts ──
    var activeHistory: any;
    var isRealUserMessage: any;
    var lastExchange: any;
    var msgText: any;
    var stripInjected: any;
    // ── bridged by init.ts ──
    var _addPriorityItem: any;
    var _addVoiceItem: any;
    var _movePriorityItem: any;
    var _moveVoiceItem: any;
    var _removePriorityItem: any;
    var _removeVoiceItem: any;
    var activateTab: any;
    var addCustomModel: any;
    var addVoiceButtons: any;
    var applyHdrCompactTokens: any;
    var applyHdrReasoning: any;
    var applyHdrSearch: any;
    var closeFileTab: any;
    var createRuleFromForm: any;
    var createSkillFromForm: any;
    var deleteCustomModel: any;
    var installSkillFromFiles: any;
    var loadSkills: any;
    var notifyLocalFileChanged: any;
    var openFileTab: any;
    var populateVoiceTab: any;
    var profileDelete: any;
    var profileDownload: any;
    var profilePreview: any;
    var profileSaveCurrent: any;
    var profileUpload: any;
    var refreshTasks: any;
    var renderMainModelList: any;
    var renderMediaModelSelectors: any;
    var renderModelCatalogTable: any;
    var renderProfilesTab: any;
    var renderSkillsChecklist: any;
    var renderToolsChecklist: any;
    var saveAgentSetting: any;
    var saveMediaModel: any;
    var saveSettings: any;
    var saveVoiceSettings: any;
    var showAddCustomModelForm: any;
    var showSettings: any;
    var speakText: any;
    var stopSpeaking: any;
    var switchSettingsTab: any;
    var switchSkillSubtab: any;
    var toggleSkill: any;
    var toggleVoiceInput: any;
    var updateActiveModelDisplay: any;
    var _resetModelWarmup: () => void;
    // ── bridged by turn-protocol.ts ──
    var _asksUser: any;
    var _BLOCKED_DECLARATION_RE: any;
    var _handleTurnState: any;
    var _isComplete: any;
    var _isUserQuestion: any;
    var _stripTerminal: any;
    var _lastStreamChunkAt: number;
    var _TERMINAL_RE: any;
    // ── bridged by llm-loops.ts ──
    var callLLM: (ep: any, payload: any, onChunk: (text: string, kind: string) => void, opts?: { onRequest?: (p: any) => void }) => Promise<any>;
    var _invalidateReadDedup: any;
    var _normPath: any;
    var _patchOAIWriteArgs: any;
    var _runToolCalls: any;
    var _validateStepOutput: any;
    var _saveAnswer: any;
    var callOAI: (onChunk: (chunk: string, type?: string) => void, onRequest: ((r: any) => void) | null, opts?: { localHistory?: any[] | null; forWorker?: boolean; endpointOverride?: any; roleOverride?: any; toolFilterOverride?: Set<string> | null; maxTokens?: number | null; inputTokensHint?: number; evtSession?: any; evtStep?: number }) => Promise<any>;
    var clearReplaceState: any;
    var clearSessionFallback: any;
    var repairOAIHistory: any;
    var runTurn: any;
    var truncateResultForHistory: any;
    // ── bridged by llm-shared.ts ──
    var RATE_LIMIT_COOLDOWN_MS: any;
    var RATE_LIMIT_MAX_MS: any;
    var RATE_LIMIT_PENALTY_MS: any;
    var _anyFreeSpec: any;
    var _defaultEndpoint: any;
    var firstFreeEndpoint: any;
    var utilityEndpoint: any;
    var getWorkerModel: any;
    var saveWorkerModel: any;
    var getUtilityModel: any;
    var saveUtilityModel: any;
    var isUtilityDisabled: any;
    var _endpointCooldown: any;
    var _endpointHits: any;
    var _endpointNeedsProbe: any;
    var _endpointSuccessSinceCooldown: any;
    var _httpErrorFromResponse: any;
    var _isCoolingDown: any;
    var _isRateLimit: any;
    var _isServerError: any;
    var _lcsMatrix: any;
    var _makeOAIRetryHandler: any;
    var _markCooldown: any;
    var _markExactCooldown: any;
    var _markFlatCooldown: any;
    var _switchToFreeModel: any;
    var applyMemoryUpdates: any;
    var compactHistory: any;
    var fmtDelay: any;
    var getCooldownRemaining: any;
    var getRateLimitFallbackEndpoint: any;
    var isTransient: any;
    var knownLimitWaitMs: any;
    var loadAgentsContext: any;
    var loadMemoryContext: any;
    var oaiEndpoint: any;
    var parseCompactResponse: any;
    var parseContextOverflow: any;
    var recordRequest: any;
    var recordSuccess: any;
    var retryDelay: any;
    var sleepInterruptible: any;
    var specToEndpoint: any;
    var isCacheCapable: any;
    var streamOAICompat: any;
    var withRetry: any;
    // ── bridged by mcp.ts ──
    var MCP_CONTEXT7_URL: any;
    var callMCPTool: any;
    // ── bridged by model-caps.ts ──
    var getModelToolFormat: any;
    var parseFnTagCalls: any;
    // ── bridged by nudge-emitter.ts ──
    var emitNudge: (name: string, textOrEntry: string | { role: string; content: string }, opts?: { role?: string; history?: any[]; step?: string; suppressLog?: boolean; suppressRender?: boolean; suppressHistory?: boolean; appendPartTo?: any[] }) => void;
    // ── bridged by payload-builder.ts ──
    var buildChatPayload: any;
    var isCustomEndpoint: any;
    var _stripThinking: any; // llm-loops.ts — consumed by history.ts repair
    // ── bridged by retry.ts ──
    var _isTimeoutError: any;
    var _parseRetryAfter: any;
    // ── bridged by stream-decode.ts ──
    var readSSE: any;
    var nonStreamOAICompat: any;
    var decodeOAIResponse: any;
    // ── bridged by model-router.ts ──
    var _nextRotationSpec: any;
    var modelFriendlyName: any;
    var resolveWorkerModelSpec: any;
    // ── bridged by history.ts ──
    var _extractCodeBlocks: any;
    var _historyResult: any;
    var _summarizeToolResult: any;
    var pruneOAIHistory: any;
    var repairHistoryArray: any;
    var resetSeenReadFiles: any;
    // ── bridged by tool-call-repair.ts ──
    var EXEC_CODE_ALIASES: any;
    var EXEC_LANG_ALIASES: any;
    var _repairJsonArgs: any;
    var _repairToolCallArgs: any;
    var _repairToolNames: any;
    var _repairExecCodeArgs: any;
    // ── bridged by detectors.ts ──
    var _checkTextResponse: any;
    var _fpHash: any;
    var _fpTrunc: any;
    var _updateBlankSteps: any;
    var _updateStuckDetector: any;
    // ── bridged by post-turn.ts ──
    var maybeRunInitAgent: any;
    var rebuildLedger: any;
    var repairLedgerIfBroken: any;
    var runPostTurnAgents: any;
    // ── bridged by prompt-suggest.ts ──
    var generateAndShowSuggestion: any;
    var clearSuggestion: any;
    var acceptSuggestion: any;
    var _tuiSetPromptSuggestion: ((text: string) => void) | undefined;
    // ── bridged by qa.ts ──
    var _updateLedgerRow: any;
    var setTaskStatus: any;
    var transitionTask: any;
    // ── bridged by fetch-blacklist.ts ──
    var blacklistAdd: (url: string) => void;
    var blacklistRemove: (url: string) => void;
    var blacklistHas: (url: string) => boolean;
    var annotateUrl: (url: string) => string;
    var stripUnavailable: (url: string) => string;
    // ── bridged by search-providers.ts ──
    var braveSearch: any;
    var performWebSearch: any;
    var tavilySearch: any;
    var wikipediaSearch: any;
    // ── bridged by session-schema.ts ──
    var SESSION_SCHEMA_SQL: any;
    // ── bridged by session-store.ts ──
    var setSessionStore: any;
    var sessionSyncChatList: any;
    var sessionDeleteChat: any;
    var sessionSetChatRole: any;
    var sessionSaveHistory: any;
    var sessionCompactHistory: any;
    var sessionLogTurn: any;
    var sessionCreateWorkerRun: any;
    var sessionFinishWorkerRun: any;
    var sessionRecordWorkerAgent: any;
    var sessionSaveRawMessage: any;
    var sessionLoadRawMessages: any;
    var sessionPruneRawFrom: any;
    var sessionLoadChatList: () => Promise<{id: string; name: string; createdAt: number; lastAt: number}[]>;
    var sessionLoadHistory: (chatId: string) => Promise<any[] | null>;
    // ── bridged by idb-session-adapter.ts ──
    var initIDBSession: () => Promise<void>;
    // ── bridged by settings-ui.ts ──
    var _handleDragLeave: any;
    var _handleDragOver: any;
    var _handleDragStart: any;
    var _handleDrop: any;
    var _settingsPopulating: any;
    var _togglePauseItem: any;
    var applyHdrRetryMode: any;
    var applyHdrTemperature: any;
    var applyHdrTopK: any;
    var applyHdrTopP: any;
    var hideModelCooldownPopup: any;
    var initHdrPicker: any;
    var onPyodideAutoloadChange: any;
    var onSandboxProviderChange: any;
    var populateSamplingSettings: any;
    var populateSettingsForm: any;
    var renderRolesTab: any;
    var saveSamplingSetting: any;
    var showModelCooldownPopup: any;
    var showModelUpdateModal: () => void;
    var updateInputModelBtn: () => void;
    // ── bridged by skill-guidance.ts ──
    var _skillExcludedForRole: any;
    var buildTriggeredGuidance: any;
    var completionGateGuidance: any;
    var evaluateSkillTriggers: any;
    var reactiveSkillGuidance: any;
    // ── bridged by turn-context.ts ──
    var _isCompletionRequest: any;
    var buildWorkspaceIndex: any;
    var collectWorkspacePaths: any;
    var applyTurnTriggers: any;
    var buildTurnPrelude: any;
    // ── bridged by skills.ts ──
    var BUILTIN_RULES: any;
    var BUILTIN_SKILLS: any;
    var _TRIGGER_FIELDS: any;
    var renderSkillsList: any;
    var setupSkillAutocomplete: any;
    // ── bridged by state.ts ──
    var _clearHistory: any;
    var _currentUserIntent: any;
    var _failureCounts: any;
    var _lastTurnDoneToken: any;
    var _reactiveFired: any;
    var _seenListFiles: any;
    var _seenReadFiles: any;
    var _toolCallHistory: any;
    var activeAbortController: any;
    var activeChatId: any;
    var activePlaceholder: any;
    var setActivePlaceholder: any;
    var setSessionToolFilter: (v: Set<string> | null) => void;
    var softStopPending: any;
    var agentStreaming: any;
    var workflowMode: boolean;
    var currentTurnSkills: any;
    var lastProvider: any;
    var lastUserMessageText: any;
    var _userInputHistory: string[];
    var mainAgentRole: any;
    var memoryContext: any;
    var openaiHistory: any;
    var pendingAgentsContextInject: any;
    var pendingMemoryInject: any;
    var setActiveAbortController: any;
    var setActiveChatId: any;
    var setActivePlaceholder: any;
    var setSoftStopPending: any;
    var setAgentStreaming: any;
    var setCurrentTurnSkills: any;
    var setCurrentUserIntent: any;
    var setFailureCounts: any;
    var setLastProvider: any;
    var setLastTurnDoneToken: any;
    var setLastUserMessageText: any;
    var setMemoryContext: any;
    var setOpenaiHistory: any;
    var setPendingAgentsContextInject: any;
    var setPendingMemoryInject: any;
    var setReactiveFired: any;
    var setSeenListFiles: any;
    var setSeenReadFiles: any;
    var setToolCallHistory: any;
    // ── bridged by step-validator.ts ──
    var AGENT_TOOL_NAMES: any;
    var extractPayload: any;
    var validateOutput: any;
    // ── bridged by system-prompt.ts ──
    var buildSystemPrompt: () => string;
    var _buildWorkspaceDesc: () => string;
    var _buildLangsDesc: () => string;
    var _buildEnvContext: () => string;
    // ── bridged by tabs.ts ──
    var openArtifactTab: any;
    // ── bridged by tasks.ts ──
    var loadTaskFiles: any;
    var syncLedgerWithTaskFiles: any;
    // ── bridged by tool-schemas.ts ──
    var _hasBashOrCode: any;
    var activeTools: any;
    var buildOAITools: any;
    // ── bridged by tools.ts ──
    var executeToolAsync: any;
    var resolveToolApproval: any;
    var toolLabel: any;
    // ── bridged by workers.ts ──
    var _filterRoleBody: any;
    var analyzeToolResult: any;
    var buildWorkerSystemPrompt: any;
    var callLLMComplete: (prompt: string, opts?: { temperature?: number; maxTokens?: number; endpoint?: any; label?: string; history?: any[] | null; maxAttempts?: number }, handle?: any) => Promise<string>;
    var clearMainAgentRole: any;
    var diffRegions: any;
    var executeWorkers: any;
    var loadRoles: any;
    var restoreRoleForChat: any;
    var rolesRegistry: any;
    var runWorkerTurn: any;
    var setMainAgentRole: any;
    var splitLines: any;
    // ── bridged by workspace.ts ──
    var _base64ToUint8: any;
    var _extOf: any;
    var _fgAudioCtx: any;
    var _fgPlayRaw: any;
    var _isBinaryExt: any;
    var _isDocExt: any;
    var _uint8ToBase64: any;
    var agentDeleteFile: any;
    var agentListFiles: any;
    var agentListFilesInDir: (dir: string) => Promise<Array<{name: string}>>;
    var agentListFilesNoStat: () => Promise<Array<{name: string}>>;
    var agentReadFile: any;
    var agentWriteFile: any;
    var buildPyRunnerHtml: any;
    var cleanupDanglingCheckpoints: any;
    var clearProject: any;
    var closeFsaFolder: any;
    var confirmDeleteFile: any;
    var copyFileBetween: any;
    var deleteCheckpointData: any;
    var deleteFsaFile: any;
    var deleteSelected: any;
    var deleteWorkspaceFile: any;
    var downloadFile: any;
    var downloadSelected: any;
    var ensureDB: any;
    var exportProject: any;
    var fsaHandle: any;
    var fsaSupported: any;
    var getCheckpointDiff: any;
    var getWorkspaceFilesDict: any;
    var importProject: any;
    var initDB: any;
    var listWorkspaceFiles: any;
    var loadProjectUI: any;
    var onerror: any;
    var onunhandledrejection: any;
    var openLocalFolder: any;
    var pollFsaChanges: any;
    var readFileAsDataUrl: any;
    var readWorkspaceFile: any;
    var reconnectLocalFolder: any;
    var renderFileList: any;
    var restoreCheckpointWorkspace: any;
    var saveCheckpointSnapshot: any;
    var saveProject: any;
    var setWorkspaceAdapter: any;
    var takeWorkspaceSnapshot: any;
    var tryRestoreLocalFolder: any;
    var updateFsaBadge: any;
    var updateSelectionUI: any;
    var uploadFiles: any;
    var writeFsaFile: any;
    var writeWorkspaceFile: any;
    var _lastCompactSummary: any; // live accessor from llm-shared.ts
    // ── CDN / environment globals ──
    var Prism: any; // prism CDN
    var TurndownService: any; // turndown CDN
    var XLSX: any; // xlsx CDN
    var importScripts: any; // WebWorker global (pyodide-worker.ts)
    var loadPyodide: any; // pyodide CDN
    var mammoth: any; // mammoth CDN
    var marked: any; // marked CDN
    var pdfjsLib: any; // pdf.js CDN

    // ── File System Access API — not (yet) in lib.dom.d.ts ──
    var showDirectoryPicker: ((opts?: any) => Promise<any>) | undefined;
    interface Window {
        showDirectoryPicker?: (opts?: any) => Promise<any>;
        SpeechRecognition?: any;
        webkitSpeechRecognition?: any;
    }
    interface FileSystemHandle {
        requestPermission?: (opts?: any) => Promise<string>;
        queryPermission?: (opts?: any) => Promise<string>;
    }

    // ── Error expando fields used by the retry/cooldown machinery ──
    // (llm-loops.ts, llm-shared.ts, workers.ts stash rate-limit metadata on caught errors)
    interface Error {
        retryAfterMs?: number;
        status?: number;
        preFlight?: boolean;
        code?: string;
    }
}

export {};
