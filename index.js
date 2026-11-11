/**
 * Desktop notifications for DeepSeek Harness — the Host half.
 *
 * One job: when a task changes state in a way the user must know about, raise a
 * Windows toast that says *where* it happened, *which* workspace owns it, *how
 * long* it ran, and *what* actually came out of it. Four things are announced:
 *
 *  - a task finished (the agent went idle after running);
 *  - a task failed (the turn ended with an error, or ran out of context);
 *  - a task is blocked (the turn closed blocked);
 *  - the agent is waiting for the user (an `ask_user_question` prompt, or an
 *    approval request).
 *
 * Every live session is watched, so all workspaces are covered; the owning
 * workspace is resolved through `workspaceRegistry` and shown by title and path.
 *
 * Why a PowerShell subprocess: the Host runs inside Electron's utility process,
 * which has no `electron` module, so `new Notification()` is out of reach. A
 * short-lived Windows PowerShell 5.1 process talks to WinRT
 * (`Windows.UI.Notifications`) directly and posts a real toast, attributed to
 * the app through its own AppUserModelID (`com.deepseek.dsh`).
 *
 * The bundle is deliberately dependency-free — no `@deepseek-ai/*` imports — so
 * it installs into any profile without a build step, and a delivery failure can
 * never affect the agent loop: delivery is fire-and-forget and errors are logged.
 *
 * Tunables live in the plugin row's `config` (this package's cordis.patch.yml).
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Toast text limits, in UTF-16 code units. */
const TITLE_LIMIT = 64
const LINE_LIMIT = 110
const DETAIL_LIMIT = 100

/** How many toast subprocesses may be in flight before extra ones are dropped. */
const MAX_IN_FLIGHT = 3

/** Where the browser half reads and writes this plugin's settings. */
const SETTINGS_PATH = '/api/desktop-notify.settings'

/** Where the settings page asks for a live test toast. */
const TEST_PATH = '/api/desktop-notify.test'

/** Where the page collects a toast activation waiting for it. */
const PENDING_PATH = '/api/desktop-notify.pending'

/** The protocol the toast launches; the desktop app has no session deep link of its own. */
const PROTOCOL = 'dsh-notify'

/** How long an activation marker stays valid, in milliseconds. */
const ACTIVATION_TTL_MS = 120000

/** Turn outcomes worth a toast, and how each one reads. `gate` selects the config switch. */
const OUTCOME = {
  completed: { icon: '✅', label: 'completed', gate: 'completed' },
  error: { icon: '⚠️', label: 'failed', gate: 'error' },
  'max-tokens': { icon: '⚠️', label: 'exhausted', gate: 'error' },
  blocked: { icon: '⛔', label: 'blocked', gate: 'blocked' }
}

/** Every user-visible string, per supported locale. */
const STRINGS = {
  zh: {
    completed: '任务完成',
    failed: '任务失败',
    exhausted: '上下文用尽',
    blocked: '任务阻塞',
    needsAnswer: '等待你的回答',
    needsApproval: '等待你的确认',
    duration: (value) => `耗时 ${value}`,
    elapsed: (value) => `已运行 ${value}`,
    unnamedWorkspace: '未命名工作区',
    noWorkspace: '未归属工作区',
    selftest: '通知已接通',
    fallbackDetail: '任务已结束，没有可展示的摘要'
  },
  ja: {
    completed: 'タスク完了',
    failed: 'タスク失敗',
    exhausted: 'コンテキスト枯渇',
    blocked: 'タスク停止',
    needsAnswer: '回答待ち',
    needsApproval: '確認待ち',
    duration: (value) => `所要 ${value}`,
    elapsed: (value) => `実行中 ${value}`,
    unnamedWorkspace: '名称未設定のワークスペース',
    noWorkspace: 'ワークスペース未所属',
    selftest: '通知テスト',
    fallbackDetail: 'タスクは終了しました'
  },
  en: {
    completed: 'Task completed',
    failed: 'Task failed',
    exhausted: 'Context exhausted',
    blocked: 'Task blocked',
    needsAnswer: 'Waiting for your answer',
    needsApproval: 'Waiting for your approval',
    duration: (value) => `took ${value}`,
    elapsed: (value) => `running ${value}`,
    unnamedWorkspace: 'Untitled workspace',
    noWorkspace: 'No workspace',
    selftest: 'Notifications are on',
    fallbackDetail: 'The task ended without a summary'
  }
}

/**
 * The invariant part of the delivery script. Values travel through environment
 * variables, so nothing user-provided is ever spliced into PowerShell source.
 * The toast carries a title plus up to two body lines.
 */
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$aumid = $env:DSH_TOAST_AUMID
if ([string]::IsNullOrWhiteSpace($aumid)) { $aumid = 'com.deepseek.dsh' }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$texts = '<text>' + [System.Security.SecurityElement]::Escape($env:DSH_TOAST_TITLE) + '</text>'
if (-not [string]::IsNullOrWhiteSpace($env:DSH_TOAST_LINE1)) {
  $texts += '<text>' + [System.Security.SecurityElement]::Escape($env:DSH_TOAST_LINE1) + '</text>'
}
if (-not [string]::IsNullOrWhiteSpace($env:DSH_TOAST_LINE2)) {
  $texts += '<text>' + [System.Security.SecurityElement]::Escape($env:DSH_TOAST_LINE2) + '</text>'
}
$audio = ''
if ($env:DSH_TOAST_SILENT -eq '1') { $audio = '<audio silent="true"/>' }
$activation = ''
if (-not [string]::IsNullOrWhiteSpace($env:DSH_TOAST_LAUNCH)) {
  $activation = ' activationType="protocol" launch="' + [System.Security.SecurityElement]::Escape($env:DSH_TOAST_LAUNCH) + '"'
}
$xml = '<toast' + $activation + '><visual><binding template="ToastGeneric">' + $texts + '</binding></visual>' + $audio + '</toast>'
$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$document.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $document
if (-not [string]::IsNullOrWhiteSpace($env:DSH_TOAST_TAG)) { try { $toast.Tag = $env:DSH_TOAST_TAG } catch { } }
try { $toast.Group = 'dsh-notify' } catch { }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
`

/** The script as a single `-EncodedCommand` argument (base64 of UTF-16LE). */
const ENCODED_SCRIPT = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64')

/** The Windows PowerShell 5.1 host — WinRT projection is unavailable in PowerShell 7. */
const POWERSHELL_EXE = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

/** The registry tool used to own (and later drop) the app's notification identity. */
const REG_EXE = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')

/** The icon shipped with this bundle, extracted from the Harness executable. */
const BUNDLED_ICON = fileURLToPath(new URL('./assets/app-icon.png', import.meta.url))

/** The protocol-handler script shipped with this bundle. */
const BUNDLED_OPEN_SCRIPT = fileURLToPath(new URL('./assets/notify-open.ps1', import.meta.url))

/**
 * Process-wide identity bookkeeping, deliberately keyed on `globalThis` rather
 * than a module-scoped binding: a hot-reloaded copy of this module must share
 * the live-instance count with the copy it replaces, or the outgoing copy's
 * deferred cleanup would tear the registration down under the incoming one.
 */
const IDENTITY_KEY = Symbol.for('dsh.desktop-notify.identity')

/**
 * How long the Windows registration outlives the last live instance before it is
 * removed. The delay is what separates "the plugin was uninstalled" (the process
 * stays up, nobody reclaims, the cleanup runs) from "the app is shutting down"
 * (the process exits and the timer dies with it, so the identity survives).
 */
const IDENTITY_GRACE_MS = 15000

/**
 * Pick the locale to speak. `auto` follows the operating system, which Node
 * reports through `Intl` — the value the user sees in Windows regional settings.
 * @param configured - the config value, already normalized to a string.
 * @returns one of the supported locales.
 */
function resolveLocale(configured) {
  if (configured === 'zh' || configured === 'ja' || configured === 'en') return configured
  const candidates = [process.env.DSH_LOCALE, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]
  try {
    candidates.unshift(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    // No ICU locale information: fall through to the environment and then English.
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const tag = candidate.toLowerCase()
    if (tag.startsWith('zh')) return 'zh'
    if (tag.startsWith('ja')) return 'ja'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

/**
 * Render a millisecond duration in the shape the locale expects.
 * @param ms - elapsed time in milliseconds.
 * @param locale - one of the supported locales.
 * @returns a compact duration label, or an empty string for a non-duration.
 */
function formatDuration(ms, locale) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (locale === 'en') {
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }
  if (locale === 'ja') {
    if (hours > 0) return `${hours}時間${minutes}分`
    if (minutes > 0) return `${minutes}分${seconds}秒`
    return `${seconds}秒`
  }
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

/**
 * Run one reg.exe invocation.
 * @param args - the arguments after the executable.
 * @returns whether reg.exe exited successfully.
 */
function reg(args) {
  try {
    const result = spawnSync(REG_EXE, args, { stdio: 'ignore', windowsHide: true, timeout: 10000 })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Read the shared identity record.
 * @returns the process-wide live count and the pending cleanup timer.
 */
function identityState() {
  if (globalThis[IDENTITY_KEY] === undefined) {
    globalThis[IDENTITY_KEY] = { live: 0, timer: undefined }
  }
  return globalThis[IDENTITY_KEY]
}

/** The per-user directory this plugin owns on Windows. */
function stateDir() {
  const base = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  return join(base, 'dsh-notify')
}

/** Where the icon copy that Windows points at lives between activations. */
function installedIconPath() {
  return join(stateDir(), 'app-icon.png')
}

/** Where the toast activation marker is dropped for the page to collect. */
function activationFile() {
  return join(stateDir(), 'activate.json')
}

/** Where the protocol handler script lives once installed. */
function installedOpenScript() {
  return join(stateDir(), 'notify-open.ps1')
}

/**
 * Register this AUMID with Windows, so the notification settings page and the
 * toasts show a name and an icon instead of a bare identifier, and teach Windows
 * the click target the toasts carry. Idempotent.
 * @param aumid - the AppUserModelID the plugin posts with.
 * @param log - the diagnostic sink.
 */
function claimIdentity(aumid, log) {
  const icon = installedIconPath()
  const script = installedOpenScript()
  try {
    mkdirSync(stateDir(), { recursive: true })
    let sized = 0
    try {
      sized = statSync(icon).size
    } catch {
      sized = 0
    }
    if (sized === 0) copyFileSync(BUNDLED_ICON, icon)
    copyFileSync(BUNDLED_OPEN_SCRIPT, script)
  } catch (error) {
    log(`assets could not be installed in ${stateDir()}: ${String(error)}`)
  }

  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`
  reg(['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'DeepSeek Harness', '/f'])
  reg(['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', icon, '/f'])

  const root = `HKCU\\Software\\Classes\\${PROTOCOL}`
  const command =
    `"${POWERSHELL_EXE}" -NoProfile -NonInteractive -WindowStyle Hidden ` +
    `-ExecutionPolicy Bypass -File "${script}" "%1"`
  reg(['add', root, '/ve', '/t', 'REG_SZ', '/d', 'URL:DeepSeek Harness notification', '/f'])
  reg(['add', root, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'])
  reg(['add', `${root}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'])
}

/**
 * Remove everything {@link claimIdentity} created, including the per-app
 * notification settings row Windows writes when it first accepts a toast.
 * @param aumid - the AppUserModelID to forget.
 * @param log - the diagnostic sink.
 */
function removeIdentity(aumid, log) {
  const settings = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${aumid}`
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`
  const protocol = `HKCU\\Software\\Classes\\${PROTOCOL}`
  const settingsGone = reg(['delete', settings, '/f'])
  const keyGone = reg(['delete', key, '/f'])
  const protocolGone = reg(['delete', protocol, '/f'])
  try {
    rmSync(stateDir(), { recursive: true, force: true })
  } catch {
    // A leftover directory is harmless; the registrations that point into it are gone.
  }
  if (settingsGone || keyGone || protocolGone) log(`removed the Windows registration for ${aumid}`)
}

/**
 * Take the activation marker a click left behind, if any.
 * @returns the session id to open, once.
 */
function drainActivation() {
  const file = activationFile()
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    rmSync(file, { force: true })
  } catch {
    // The marker is consumed logically even when the file cannot be removed.
  }
  try {
    const parsed = JSON.parse(raw)
    const session = parsed?.session
    if (typeof session !== 'string' || session.length === 0 || session.length > 512) return undefined
    const at = typeof parsed?.at === 'number' ? parsed.at : Date.now()
    if (Date.now() - at > ACTIVATION_TTL_MS) return undefined
    return { session, at }
  } catch {
    return undefined
  }
}

/**
 * Take ownership of the identity for one activation, cancelling any cleanup a
 * previous instance left pending.
 * @param config - resolved plugin config.
 * @param log - the diagnostic sink.
 */
function claim(config, log) {
  const state = identityState()
  if (state.timer !== undefined) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
  state.live += 1
  if (config.manageIdentity) claimIdentity(config.aumid, log)
}

/**
 * Drop one activation's ownership; the last instance out schedules the cleanup,
 * which only survives if the process outlives it.
 * @param config - resolved plugin config.
 * @param log - the diagnostic sink.
 */
function release(config, log) {
  const state = identityState()
  state.live = Math.max(0, state.live - 1)
  if (!config.manageIdentity || state.live > 0) return
  if (state.timer !== undefined) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = undefined
    if (state.live > 0) return
    removeIdentity(config.aumid, log)
  }, IDENTITY_GRACE_MS)
  state.timer.unref?.()
}

/**
 * The click target carried by one session's toast. The desktop app has no
 * session deep link, so the toast launches this plugin's own protocol and the
 * awaiting page turns it into navigation.
 * @param id - the session id.
 * @returns the protocol URL, or undefined when there is no session.
 */
function launchOf(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined
  return `${PROTOCOL}://${encodeURIComponent(id)}`
}

/** The sink for debug lines; installed when the row enables `debug`. */
let debugSink = undefined

/**
 * Record one diagnostic line where the debug log lives, when one is installed.
 * @param message - the line to record.
 */
function debugLine(message) {
  if (debugSink === undefined) return
  try {
    debugSink(`[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Debug logging must never be the reason something fails.
  }
}

/**
 * Rebuild the start of a turn that was already running when this instance
 * activated. Reloading the plugin (a config save, an HMR reload, an app
 * restart) must not mute the notification for work that is still in flight, and
 * the durable log is where that start time lives.
 * @param session - the live session to inspect.
 * @returns the open turn's start time and latest reply, or undefined when idle.
 */
function openRunOf(session) {
  const last = Number(session.seq)
  const from = Number(session.firstLiveSeq ?? 0)
  let text = ''
  let scanned = 0
  for (let seq = last - 1; seq >= from && scanned < 50000; seq -= 1, scanned += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/end') return undefined
    if (event.type === 'turn/start') return { startedAt: event.time, text }
    if (event.type === 'assistant/message' && text.length === 0) {
      text = textOfBlocks(event.data?.message?.content)
    }
  }
  return undefined
}

/**
 * A JSON response that is never cached.
 * @param value - the payload.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** Read a boolean config field, falling back when the value is not a boolean. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a non-negative numeric config field, falling back on anything else. */
function count(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Read a non-empty string config field, falling back on anything else. */
function text(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Normalize the row's raw config into the shape the plugin reads.
 * @param raw - the `config` object of the Loader entry, if any.
 * @returns every field with its default applied.
 */
function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const events = source.events !== null && typeof source.events === 'object' ? source.events : {}
  const configured = text(source.locale, 'auto').toLowerCase()
  // `locale` is resolved for the message strings; `localePreference` is what the
  // settings page shows and writes back, so choosing "follow the system" stays a
  // choice instead of collapsing into whatever the system resolved to.
  const preference = configured === 'zh' || configured === 'ja' || configured === 'en' ? configured : 'auto'
  return {
    enabled: bool(source.enabled, true),
    events: {
      completed: bool(events.completed, true),
      error: bool(events.error, true),
      blocked: bool(events.blocked, true),
      needsInput: bool(events.needsInput, true),
      approval: bool(events.approval, true)
    },
    locale: preference === 'auto' ? resolveLocale('auto') : preference,
    localePreference: preference,
    includeSubagents: bool(source.includeSubagents, false),
    minDurationMs: count(source.minDurationMs, 3000),
    settleMs: count(source.settleMs, 1500),
    dedupeMs: count(source.dedupeMs, 5000),
    sound: bool(source.sound, true),
    aumid: text(source.aumid, 'com.deepseek.dsh'),
    manageIdentity: bool(source.manageIdentity, true),
    testOnStart: bool(source.testOnStart, false),
    debug: bool(source.debug, false)
  }
}

/**
 * Collapse arbitrary text into one notification-safe line.
 * @param value - untrusted text.
 * @param limit - maximum length in UTF-16 code units.
 * @returns a trimmed single-line prefix of `value`.
 */
function oneLine(value, limit) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/gu, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

/**
 * Join the text blocks of one message into a single line.
 * @param blocks - content blocks of an assistant message.
 * @returns the flattened text, or an empty string when there is none.
 */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join(' ').trim()
}

/**
 * A short, stable toast tag for one session, so a later toast replaces the
 * earlier one instead of stacking. Windows caps a tag at 16 characters.
 * @param value - the session id.
 * @returns a hex digest that fits the tag limit.
 */
function tagOf(value) {
  let hash = 5381
  const source = String(value)
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Resolve the workspace that owns one session.
 * @param ctx - Host context, used to reach the durable registry.
 * @param id - the session id.
 * @returns the owning workspace, when the session belongs to one.
 */
function workspaceOf(ctx, id) {
  if (typeof id !== 'string' || id.length === 0) return undefined
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return undefined
    for (const workspace of registry.list()) {
      const ids = workspace?.sessionIds
      if (Array.isArray(ids) && ids.includes(id)) return workspace
    }
  } catch {
    // The registry is optional decoration; a failure just drops the workspace.
  }
  return undefined
}

/**
 * The conversation title the sidebar shows, when the title service is present.
 * @param ctx - Host context.
 * @param session - live session object, when one is known.
 * @returns the title, or an empty string.
 */
function sessionTitleOf(ctx, session) {
  if (session === undefined || session === null) return ''
  try {
    const titles = ctx.get('sessionTitle')
    if (titles === undefined || typeof titles.get !== 'function') return ''
    const snapshot = titles.get(session)
    if (snapshot !== undefined && typeof snapshot.title === 'string') return snapshot.title
  } catch {
    // A title is decoration: any failure just drops it.
  }
  return ''
}

/**
 * Deliver one toast through a short-lived PowerShell process.
 *
 * Delivery is fire-and-forget: the caller never awaits it, and a failure is
 * logged once and then ignored, so a broken notification channel can never
 * disturb the agent loop.
 */
class Toaster {
  /** @param ctx - Host context, for its logger. @param config - resolved plugin config. */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.inFlight = 0
    this.failures = 0
    this.lastError = ''
  }

  /**
   * Post one notification.
   * @param toast - the title, up to two body lines, and the dedupe tag.
   * @returns nothing; the delivery settles in the background.
   */
  post(toast) {
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.warn(`dropped "${toast.title}": ${this.inFlight} deliveries already in flight`)
      return
    }
    if (this.config.debug) {
      this.warn(`sending "${toast.title}" | ${toast.line1 ?? ''} | ${toast.line2 ?? ''}`)
    }
    this.inFlight += 1
    let child
    try {
      child = spawn(
        POWERSHELL_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT],
        {
          env: {
            ...process.env,
            DSH_TOAST_AUMID: this.config.aumid,
            DSH_TOAST_TITLE: toast.title,
            DSH_TOAST_LINE1: toast.line1 ?? '',
            DSH_TOAST_LINE2: toast.line2 ?? '',
            DSH_TOAST_TAG: toast.tag ?? '',
            DSH_TOAST_LAUNCH: toast.launch ?? '',
            DSH_TOAST_SILENT: this.config.sound ? '0' : '1'
          },
          stdio: 'ignore',
          windowsHide: true
        }
      )
    } catch (error) {
      this.inFlight -= 1
      this.report(error)
      return
    }
    child.on('error', (error) => {
      this.inFlight -= 1
      this.report(error)
    })
    child.on('exit', (code) => {
      this.inFlight -= 1
      if (code !== 0) this.report(new Error(`powershell exited with code ${code}`))
    })
    child.unref()
  }

  /**
   * Log a delivery failure, suppressing repeats of the same message.
   * @param error - whatever the delivery path rejected with.
   */
  report(error) {
    this.failures += 1
    const message = error instanceof Error ? error.message : String(error)
    if (message === this.lastError && this.failures > 2) return
    this.lastError = message
    this.warn(`delivery failed (${this.failures} total): ${message}`)
  }

  /**
   * Write one diagnostic line to the Host log.
   * @param message - the line to record.
   */
  warn(message) {
    try {
      this.ctx.logger?.warn?.(`desktop-notify: ${message}`)
    } catch {
      // Logging is best-effort too.
    }
    debugLine(message)
  }
}

/**
 * Register the plugin against one Host context.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the Loader row's `config` object.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const L = STRINGS[config.locale] ?? STRINGS.en

  if (!config.enabled) {
    ctx.logger?.info?.('desktop-notify: disabled by config')
    return
  }
  if (process.platform !== 'win32') {
    ctx.logger?.info?.(`desktop-notify: inactive on ${process.platform}; Windows only`)
    return
  }

  const toaster = new Toaster(ctx, config)

  /** Per-session bookkeeping: what ran, how it ended, and what was last said. */
  const sessions = new Map()
  /** Sessions whose last idle has already been announced, to keep one toast per run. */
  const announced = new Set()

  /** Read (or create) the bookkeeping record for one session id. */
  const stateOf = (id) => {
    let state = sessions.get(id)
    if (state === undefined) {
      state = {
        session: undefined,
        lastText: '',
        runStart: undefined,
        runEnd: undefined,
        outcome: undefined,
        timer: undefined,
        lastKey: '',
        lastAt: 0
      }
      sessions.set(id, state)
    }
    return state
  }

  /** Whether this plugin is allowed to speak about one session. */
  const skipSession = (session) => {
    if (session === undefined || session === null) return false
    return !config.includeSubagents && session.header?.origin === 'subagent'
  }

  /** Resolve one live Session, preferring what the event feed already handed us. */
  const sessionById = (id) => {
    if (typeof id !== 'string' || id.length === 0) return undefined
    const known = sessions.get(id)?.session
    if (known !== undefined) return known
    try {
      return ctx.get('sessions')?.get(id)
    } catch {
      return undefined
    }
  }

  /**
   * Everything a toast needs about one session's location.
   * @param session - the live session, when known.
   * @returns the workspace title, the directory to show, and the short fallback title.
   */
  const placeOf = (session) => {
    const id = session?.id
    const workspace = workspaceOf(ctx, id)
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
    const path = typeof workspace?.path === 'string' && workspace.path.length > 0 ? workspace.path : cwd
    const fallback = path.length > 0 ? basename(path) : L.noWorkspace
    const title = typeof workspace?.title === 'string' && workspace.title.trim().length > 0
      ? workspace.title.trim()
      : fallback
    return { title, path }
  }

  /** Drop a pending settle timer for one session. */
  const cancelSettle = (state) => {
    if (state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
  }

  /**
   * Announce a finished run, if a run actually finished and it is worth it.
   * @param id - the session id whose agent went idle.
   */
  const announce = (id) => {
    const state = sessions.get(id)
    if (state === undefined) return
    const outcome = state.outcome
    const startedAt = state.runStart
    const endedAt = state.runEnd
    state.runStart = undefined
    state.runEnd = undefined
    state.outcome = undefined
    if (outcome === undefined || startedAt === undefined) return
    const session = state.session
    if (skipSession(session)) return
    const entry = OUTCOME[outcome.kind]
    if (entry === undefined) return
    if (!config.events[entry.gate]) return

    const elapsed = (endedAt ?? Date.now()) - startedAt
    if (elapsed < config.minDurationMs) {
      if (config.debug) {
        toaster.warn(`skipped ${id}: ran ${formatDuration(elapsed, config.locale)}, under the ${config.minDurationMs}ms floor`)
      }
      return
    }
    const key = `run:${entry.gate}`
    if (key === state.lastKey && Date.now() - state.lastAt < config.dedupeMs) return
    state.lastKey = key
    state.lastAt = Date.now()

    const place = placeOf(session)
    const detail = outcome.kind === 'error' && typeof outcome.error?.message === 'string'
      ? oneLine(outcome.error.message, DETAIL_LIMIT)
      : oneLine(state.lastText, DETAIL_LIMIT)
    const conversation = oneLine(sessionTitleOf(ctx, session), 40)
    const line2 = detail.length > 0
      ? conversation.length > 0 ? `${conversation}：${detail}` : detail
      : conversation.length > 0 ? conversation : L.fallbackDetail

    toaster.post({
      title: oneLine(`${entry.icon} ${L[entry.label]} · ${place.title}`, TITLE_LIMIT),
      line1: oneLine(`${place.path} · ${L.duration(formatDuration(elapsed, config.locale))}`, LINE_LIMIT),
      line2: oneLine(line2, LINE_LIMIT),
      tag: tagOf(id),
      launch: launchOf(id)
    })
  }

  /** Track one durable session event. */
  const onSessionEvent = (session, event) => {
    if (session === undefined || session === null || event === undefined) return
    const state = stateOf(session.id)
    state.session = session
    switch (event.type) {
      case 'turn/start': {
        if (state.runStart === undefined) {
          state.runStart = event.time
          state.lastText = ''
        }
        state.runEnd = undefined
        state.outcome = undefined
        announced.delete(session.id)
        return
      }
      case 'turn/end': {
        state.outcome = event.data?.reason
        state.runEnd = event.time
        return
      }
      case 'assistant/message': {
        const value = textOfBlocks(event.data?.message?.content)
        if (value.length > 0) state.lastText = value
        return
      }
      default:
        return
    }
  }

  /** Track the agent's running/idle transitions, which bracket one whole run. */
  const onAgentStatus = (payload) => {
    const id = payload?.agent?.id
    if (typeof id !== 'string' || id.length === 0) return
    const state = stateOf(id)
    if (payload.status === 'running') {
      cancelSettle(state)
      return
    }
    if (payload.status !== 'idle' || state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (announced.has(id)) return
      announced.add(id)
      try {
        announce(id)
      } catch (error) {
        toaster.report(error)
      }
    }, config.settleMs)
    state.timer.unref?.()
  }

  /** Announce an `ask_user_question` prompt that is now blocking the agent. */
  const onQuestion = (request, next) => {
    try {
      const id = request?.agent?.id
      const state = typeof id === 'string' ? sessions.get(id) : undefined
      const session = sessionById(id)
      if (!skipSession(session) && config.events.needsInput) {
        const question = Array.isArray(request?.questions) ? request.questions[0] : undefined
        const prompt = typeof question?.question === 'string' ? question.question : ''
        const prefix = typeof question?.header === 'string' && question.header.length > 0 ? `${question.header}：` : ''
        const key = `question:${oneLine(prompt, 40)}`
        if (!(state !== undefined && state.lastKey === key && Date.now() - state.lastAt < config.dedupeMs)) {
          if (state !== undefined) {
            state.lastKey = key
            state.lastAt = Date.now()
          }
          const place = placeOf(session)
          const running = state?.runStart !== undefined
            ? ` · ${L.elapsed(formatDuration(Date.now() - state.runStart, config.locale))}`
            : ''
          toaster.post({
            title: oneLine(`🙋 ${L.needsAnswer} · ${place.title}`, TITLE_LIMIT),
            line1: oneLine(`${place.path}${running}`, LINE_LIMIT),
            line2: oneLine(`${prefix}${prompt}` || L.fallbackDetail, LINE_LIMIT),
            tag: tagOf(id ?? 'question'),
            launch: launchOf(id)
          })
        }
      }
    } catch (error) {
      toaster.report(error)
    }
    return next()
  }

  /** Announce an approval prompt, which blocks the agent the same way. */
  const onApproval = (request, next) => {
    try {
      const id = request?.agent?.id
      if (config.events.approval) {
        const session = sessionById(id)
        if (!skipSession(session)) {
          const subject =
            request?.subject?.name ??
            request?.tool?.name ??
            request?.toolName ??
            request?.request?.toolName ??
            request?.kind ??
            ''
          const place = placeOf(session)
          toaster.post({
            title: oneLine(`🔐 ${L.needsApproval} · ${place.title}`, TITLE_LIMIT),
            line1: oneLine(place.path, LINE_LIMIT),
            line2: oneLine(typeof subject === 'string' && subject.length > 0 ? subject : L.fallbackDetail, LINE_LIMIT),
            tag: tagOf(id ?? 'approval'),
            launch: launchOf(id)
          })
        }
      }
    } catch (error) {
      toaster.report(error)
    }
    return next()
  }

  /** Forget everything the plugin held for a session that left the store. */
  const onSessionDisposed = (session) => {
    const id = session?.id
    if (typeof id !== 'string') return
    const state = sessions.get(id)
    if (state !== undefined) cancelSettle(state)
    sessions.delete(id)
    announced.delete(id)
  }

  /** Write one diagnostic line about the plugin's own lifecycle. */
  const note = (message) => {
    try {
      ctx.logger?.info?.(`desktop-notify: ${message}`)
    } catch {
      // Logging is best-effort.
    }
    debugLine(message)
  }

  // The decision log is always on: "why did no notification appear" is otherwise
  // unanswerable from outside the Host process. It rotates at 1 MB and holds only
  // what the toast itself showed.
  {
    const file = join(stateDir(), 'debug.log')
    try {
      mkdirSync(stateDir(), { recursive: true })
      try {
        if (statSync(file).size > 1_000_000) writeFileSync(file, '')
      } catch {
        // A missing log is the normal first run.
      }
      debugSink = (line) => appendFileSync(file, line)
    } catch {
      debugSink = undefined
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.on('session/event', onSessionEvent),
      ctx.on('agent/status', onAgentStatus),
      ctx.on('user-questions/request', onQuestion),
      ctx.on('approval/request', onApproval),
      ctx.on('session/disposed', onSessionDisposed)
    ]
    claim(config, note)

    // Adopt every turn that is already running, so a reload during a long task
    // still ends with a notification instead of "no run was observed".
    let adopted = 0
    try {
      const store = ctx.get('sessions')
      if (store !== undefined && typeof store.list === 'function') {
        for (const session of store.list()) {
          if (skipSession(session)) continue
          const state = stateOf(session.id)
          if (state.runStart !== undefined) continue
          const open = openRunOf(session)
          if (open === undefined) continue
          state.session = session
          state.runStart = open.startedAt
          state.lastText = open.text
          adopted += 1
        }
      }
    } catch (error) {
      note(`could not adopt in-flight runs: ${String(error)}`)
    }
    if (adopted > 0) note(`adopted ${adopted} in-flight run(s) from the session log`)

    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
      for (const state of sessions.values()) cancelSettle(state)
      sessions.clear()
      announced.clear()
      release(config, note)
    }
  }, 'desktop-notify: listeners')

  /** The fields the settings page owns, exactly as that page sees them. */
  const settingsView = () => ({
    enabled: config.enabled,
    locale: config.localePreference,
    events: { ...config.events },
    minDurationMs: config.minDurationMs,
    includeSubagents: config.includeSubagents,
    sound: config.sound
  })

  /** Whether this profile can persist a settings change at all. */
  const canEdit = () => {
    try {
      const editor = ctx.get('configEditor')
      return editor !== undefined && (ctx.fiber?.entry ?? ctx.entry) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Validate one settings payload, keeping only the fields the page owns.
   * @param body - the parsed request body.
   * @returns the patch, or undefined when the body is unusable.
   */
  const readPatch = (body) => {
    if (body === null || typeof body !== 'object') return undefined
    const patch = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.sound === 'boolean') patch.sound = body.sound
    if (typeof body.includeSubagents === 'boolean') patch.includeSubagents = body.includeSubagents
    if (typeof body.minDurationMs === 'number' && Number.isFinite(body.minDurationMs)) {
      patch.minDurationMs = Math.min(600000, Math.max(0, Math.round(body.minDurationMs)))
    }
    if (body.locale === 'auto' || body.locale === 'zh' || body.locale === 'ja' || body.locale === 'en') {
      patch.locale = body.locale
    }
    if (body.events !== null && typeof body.events === 'object') {
      const events = {}
      for (const key of ['completed', 'error', 'blocked', 'needsInput', 'approval']) {
        if (typeof body.events[key] === 'boolean') events[key] = body.events[key]
      }
      if (Object.keys(events).length > 0) patch.events = events
    }
    return patch
  }

  /**
   * Persist one settings patch into this plugin's own row.
   * @param patch - the validated patch.
   */
  const saveSettings = async (patch) => {
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry ?? ctx.entry
    if (editor === undefined || entry === undefined) throw new Error('settings are read-only in this profile')
    await editor.edit(entry, (current) => {
      const base = current !== null && typeof current === 'object' ? current : {}
      const events = base.events !== null && typeof base.events === 'object' ? base.events : {}
      return { ...base, ...patch, events: { ...events, ...(patch.events ?? {}) } }
    })
  }

  /** The Connection carries the browser's signed cookie, so these routes need no auth of their own. */
  const connection = (() => {
    try {
      return ctx.get('connection')
    } catch {
      return undefined
    }
  })()

  if (connection !== undefined && typeof connection.fetch?.register === 'function') {
    ctx.effect(() => connection.fetch.register({
      path: SETTINGS_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          return json({ config: settingsView(), editable: canEdit(), aumid: config.aumid })
        }
        let body
        try {
          body = await request.json()
        } catch {
          return json({ error: 'bad-request' }, 400)
        }
        const patch = readPatch(body)
        if (patch === undefined) return json({ error: 'bad-request' }, 400)
        try {
          await saveSettings(patch)
          return json({ ok: true })
        } catch (error) {
          return json(
            { error: 'save-failed', message: error instanceof Error ? error.message : String(error) },
            409
          )
        }
      }
    }), 'desktop-notify: settings route')

    ctx.effect(() => connection.fetch.register({
      path: TEST_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        toaster.post({
          title: oneLine(`🔔 ${L.selftest}`, TITLE_LIMIT),
          line1: 'DeepSeek Harness',
          tag: 'selftest'
        })
        return json({ ok: true })
      }
    }), 'desktop-notify: test route')

    ctx.effect(() => connection.fetch.register({
      path: PENDING_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json(drainActivation() ?? {})
    }), 'desktop-notify: activation route')
  }

  note(
    `ready (aumid=${config.aumid}, locale=${config.locale}, floor=${config.minDurationMs}ms, ` +
    `settle=${config.settleMs}ms, debug=${config.debug})`
  )

  if (config.testOnStart) {
    toaster.post({
      title: oneLine(`🔔 ${L.selftest}`, TITLE_LIMIT),
      line1: 'DeepSeek Harness',
      tag: 'selftest'
    })
  }
}

export { POWERSHELL_SCRIPT, resolveConfig, resolveLocale }
