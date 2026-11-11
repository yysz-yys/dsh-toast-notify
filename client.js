/**
 * Client half of dsh-desktop-notify: one page inside Settings.
 *
 * It registers a single `settings.section` entry, so the notification options
 * live beside General / Models / Plugins instead of in a patch file. The page
 * is a plain form over two Host HTTP routes: `GET`/`POST` on
 * `/api/desktop-notify.settings` (read + persist through the Host's
 * `configEditor`) and `POST /api/desktop-notify.test` (send one live toast so
 * the user can hear the current sound and see the current identity).
 *
 * Two constraints follow the DSH plugin guidance:
 *
 *  - **No Harness Client package is imported as a module.** Only the platform
 *    seed `react` is required; the controls are inlined with host markup and
 *    `--dsw-alias-*` tokens so light/dark keep working.
 *  - **The page performs no config write of its own.** It posts the desired
 *    values; the Host owns the durable write and the plugin restart that makes
 *    them take effect.
 */

globalThis.__ModuleLoader__.load({
  id: 'dsh-desktop-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'desktop-notify'

    /** The Host routes; literals are cheaper than a shared module across the halves. */
    const SETTINGS_PATH = '/api/desktop-notify.settings'
    const TEST_PATH = '/api/desktop-notify.test'
    const PENDING_PATH = '/api/desktop-notify.pending'

    /** Scoped class names, prefixed so they cannot collide with host styles. */
    const CLS = {
      page: 'dsn-page',
      intro: 'dsn-intro',
      card: 'dsn-card',
      cardHead: 'dsn-card-head',
      row: 'dsn-row',
      rowText: 'dsn-row-text',
      rowTitle: 'dsn-row-title',
      rowHint: 'dsn-row-hint',
      rowControl: 'dsn-row-control',
      sw: 'dsn-switch',
      select: 'dsn-select',
      number: 'dsn-number',
      actions: 'dsn-actions',
      button: 'dsn-button',
      buttonPrimary: 'dsn-button-primary',
      notice: 'dsn-notice',
      error: 'dsn-error'
    }

    const CSS = [
      '.dsn-page{display:flex;flex-direction:column;gap:14px;padding:2px 0 24px;min-width:0;color:var(--dsw-alias-label-primary)}',
      '.dsn-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsn-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.dsn-card-head{padding:12px 16px 4px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dsn-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsn-row-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsn-row-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dsn-row-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsn-row-control{display:flex;flex:none;align-items:center;gap:8px}',
      '.dsn-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:none;border-radius:11px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s ease}',
      '.dsn-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dsn-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}',
      '.dsn-switch[aria-checked="true"]::after{transform:translateX(16px)}',
      '.dsn-switch:disabled{opacity:.5;cursor:not-allowed}',
      '.dsn-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsn-select{height:32px;min-width:132px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dsn-number{width:96px;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;text-align:right}',
      '.dsn-actions{display:flex;align-items:center;gap:8px;padding-top:2px}',
      '.dsn-button{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}',
      '.dsn-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsn-button:disabled{opacity:.5;cursor:not-allowed}',
      '.dsn-button-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.dsn-notice{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsn-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}'
    ].join('')

    /** Inject the stylesheet once per document, tagged so a reload can replace it. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-desktop-notify/desktop-notify.css'
      const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']'
      if (document.querySelector(selector) !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.append(tag)
    }

    const zh = {
      'section.title': '通知',
      intro: '任务完成、失败、阻塞或等待你操作时，弹出 Windows 通知。',
      'group.events': '通知事件',
      enabled: '启用通知',
      'enabled.hint': '总开关，关掉后不再投递任何通知。',
      completed: '任务完成',
      failed: '任务失败',
      blocked: '任务阻塞',
      needsInput: '等待你回答',
      needsApproval: '等待你确认',
      'group.content': '内容与语言',
      language: '语言',
      'language.hint': 'auto 跟随系统。影响通知文字，不影响这个设置页。',
      'language.auto': '跟随系统',
      'group.behaviour': '行为',
      'minDuration': '最短运行时长',
      'minDuration.hint': '跑得比这更短的任务不打扰，单位秒。',
      sound: '提示音',
      'sound.hint': '关闭后通知静音出现。',
      subagents: '包含子代理',
      'subagents.hint': '默认不通知子代理会话，避免一次任务弹很多条。',
      save: '保存',
      saved: '已保存',
      'save.failed': '保存失败',
      'save.unclear': '已提交，正在重新读取…',
      test: '发送测试通知',
      'test.sent': '已发送一条测试通知',
      'test.failed': '测试通知发送失败',
      loading: '正在读取设置…',
      'load.failed': '读取设置失败',
      'load.readonly': '当前 profile 不能保存配置（缺少 configEditor 或配置行）。'
    }

    const ja = {
      'section.title': '通知',
      intro: 'タスクの完了・失敗・停止、または操作待ちのときに Windows 通知を出します。',
      'group.events': '通知イベント',
      enabled: '通知を有効にする',
      'enabled.hint': '全体スイッチ。オフにすると通知は送られません。',
      completed: 'タスク完了',
      failed: 'タスク失敗',
      blocked: 'タスク停止',
      needsInput: '回答待ち',
      needsApproval: '確認待ち',
      'group.content': '内容と言語',
      language: '言語',
      'language.hint': 'auto はシステムに従います。通知本文にのみ影響します。',
      'language.auto': 'システムに従う',
      'group.behaviour': '動作',
      'minDuration': '最短実行時間',
      'minDuration.hint': 'これより短いタスクは通知しません（秒）。',
      sound: '通知音',
      'sound.hint': 'オフにすると無音で表示されます。',
      subagents: 'サブエージェントを含める',
      'subagents.hint': '既定ではサブエージェントのセッションは通知しません。',
      save: '保存',
      saved: '保存しました',
      'save.failed': '保存に失敗しました',
      'save.unclear': '送信しました。再読み込み中…',
      test: 'テスト通知を送信',
      'test.sent': 'テスト通知を送信しました',
      'test.failed': 'テスト通知の送信に失敗しました',
      loading: '設定を読み込み中…',
      'load.failed': '設定の読み込みに失敗しました',
      'load.readonly': 'このプロファイルでは設定を保存できません（configEditor または設定行がありません）。'
    }

    const en = {
      'section.title': 'Notifications',
      intro: 'Show a Windows notification when a task completes, fails, is blocked, or waits for you.',
      'group.events': 'Events',
      enabled: 'Enable notifications',
      'enabled.hint': 'Master switch. Nothing is delivered while this is off.',
      completed: 'Task completed',
      failed: 'Task failed',
      blocked: 'Task blocked',
      needsInput: 'Waiting for your answer',
      needsApproval: 'Waiting for your approval',
      'group.content': 'Content and language',
      language: 'Language',
      'language.hint': 'auto follows the system. Affects notification text only.',
      'language.auto': 'Follow system',
      'group.behaviour': 'Behaviour',
      'minDuration': 'Minimum run time',
      'minDuration.hint': 'Tasks shorter than this stay quiet, in seconds.',
      sound: 'Sound',
      'sound.hint': 'Turn off to deliver silently.',
      subagents: 'Include subagents',
      'subagents.hint': 'Off by default so one task cannot fire a dozen toasts.',
      save: 'Save',
      saved: 'Saved',
      'save.failed': 'Could not save',
      'save.unclear': 'Submitted, reloading…',
      test: 'Send test notification',
      'test.sent': 'Test notification sent',
      'test.failed': 'Could not send the test notification',
      loading: 'Loading settings…',
      'load.failed': 'Could not load settings',
      'load.readonly': 'This profile cannot save config (no configEditor or config row).'
    }

    /** A stroked bell, sized by the nav row's requested square edge. */
    function BellIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 16
      return h('svg', {
        viewBox: '0 0 24 24',
        width: edge,
        height: edge,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true
      },
        h('path', { d: 'M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z' }),
        h('path', { d: 'M10 18a2 2 0 0 0 4 0' })
      )
    }

    /** One labelled row with a control on the right. */
    function Row({ title, hint, children }) {
      return h('div', { className: CLS.row },
        h('div', { className: CLS.rowText },
          h('span', { className: CLS.rowTitle }, title),
          hint === undefined || hint === null ? null : h('span', { className: CLS.rowHint }, hint)
        ),
        h('div', { className: CLS.rowControl }, children)
      )
    }

    /** A host-styled switch: a button carrying `role="switch"` and `aria-checked`. */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: CLS.sw,
        disabled: disabled === true,
        onClick: () => onChange(!checked)
      })
    }

    /** A native select styled to the host's control metrics. */
    function Choice({ value, options, disabled, label, onChange }) {
      return h('select', {
        className: CLS.select,
        value,
        'aria-label': label,
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value)
      }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
    }

    /** The settings page itself. */
    function NotifySettingsPage({ t }) {
      const [config, setConfig] = React.useState(null)
      const [editable, setEditable] = React.useState(false)
      const [failed, setFailed] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      /** Read the Host's current view of the config. */
      const load = React.useCallback(() => {
        let alive = true
        fetch(SETTINGS_PATH, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + String(response.status))
            return response.json()
          })
          .then((payload) => {
            if (!alive) return
            setConfig(payload.config)
            setEditable(payload.editable === true)
            setFailed(null)
          })
          .catch((error) => {
            if (!alive) return
            setFailed(error instanceof Error ? error.message : String(error))
          })
        return () => {
          alive = false
        }
      }, [])

      React.useEffect(load, [load])

      /** Replace one top-level field. */
      const patch = (next) => setConfig((current) => ({ ...current, ...next }))

      /** Replace one event switch. */
      const patchEvent = (key, value) => setConfig((current) => ({
        ...current,
        events: { ...current.events, [key]: value }
      }))

      /** Persist the draft. The Host restarts the plugin, so the reply may be lost. */
      const save = async () => {
        setBusy(true)
        setNotice('')
        let response
        try {
          response = await fetch(SETTINGS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(config)
          })
        } catch {
          // The plugin restarts to apply the change, which can drop the reply
          // even though the write landed: reload and let the truth show.
          setBusy(false)
          setNotice(t('save.unclear'))
          window.setTimeout(() => load(), 900)
          return
        }
        if (!response.ok) {
          let detail = 'HTTP ' + String(response.status)
          try {
            const payload = await response.json()
            if (typeof payload?.message === 'string') detail = payload.message
            else if (typeof payload?.error === 'string') detail = payload.error
          } catch {
            // Keep the status text when the body is not JSON.
          }
          setBusy(false)
          setNotice(t('save.failed') + ' — ' + detail)
          return
        }
        setBusy(false)
        setNotice(t('saved'))
        window.setTimeout(() => load(), 900)
      }

      /** Ask the Host for one live toast, which also proves the channel still works. */
      const test = async () => {
        try {
          const response = await fetch(TEST_PATH, { method: 'POST' })
          if (!response.ok) throw new Error('HTTP ' + String(response.status))
          setNotice(t('test.sent'))
        } catch {
          setNotice(t('test.failed'))
        }
      }

      if (failed !== null) {
        return h('div', { className: CLS.page },
          h('p', { className: CLS.error }, t('load.failed') + ' — ' + failed)
        )
      }
      if (config === null) {
        return h('div', { className: CLS.page }, h('p', { className: CLS.intro }, t('loading')))
      }

      const off = busy || !editable

      return h('div', { className: CLS.page },
        h('p', { className: CLS.intro }, t('intro')),

        h('div', { className: CLS.card },
          h('div', { className: CLS.cardHead }, t('group.events')),
          h(Row, { title: t('enabled'), hint: t('enabled.hint') },
            h(Switch, {
              checked: config.enabled === true,
              disabled: off,
              label: t('enabled'),
              onChange: (value) => patch({ enabled: value })
            })
          ),
          h(Row, { title: t('completed') },
            h(Switch, {
              checked: config.events?.completed === true,
              disabled: off,
              label: t('completed'),
              onChange: (value) => patchEvent('completed', value)
            })
          ),
          h(Row, { title: t('failed') },
            h(Switch, {
              checked: config.events?.error === true,
              disabled: off,
              label: t('failed'),
              onChange: (value) => patchEvent('error', value)
            })
          ),
          h(Row, { title: t('blocked') },
            h(Switch, {
              checked: config.events?.blocked === true,
              disabled: off,
              label: t('blocked'),
              onChange: (value) => patchEvent('blocked', value)
            })
          ),
          h(Row, { title: t('needsInput') },
            h(Switch, {
              checked: config.events?.needsInput === true,
              disabled: off,
              label: t('needsInput'),
              onChange: (value) => patchEvent('needsInput', value)
            })
          ),
          h(Row, { title: t('needsApproval') },
            h(Switch, {
              checked: config.events?.approval === true,
              disabled: off,
              label: t('needsApproval'),
              onChange: (value) => patchEvent('approval', value)
            })
          )
        ),

        h('div', { className: CLS.card },
          h('div', { className: CLS.cardHead }, t('group.content')),
          h(Row, { title: t('language'), hint: t('language.hint') },
            h(Choice, {
              value: config.locale,
              disabled: off,
              label: t('language'),
              options: [
                { value: 'auto', label: t('language.auto') },
                { value: 'zh', label: '中文' },
                { value: 'ja', label: '日本語' },
                { value: 'en', label: 'English' }
              ],
              onChange: (value) => patch({ locale: value })
            })
          )
        ),

        h('div', { className: CLS.card },
          h('div', { className: CLS.cardHead }, t('group.behaviour')),
          h(Row, { title: t('minDuration'), hint: t('minDuration.hint') },
            h('input', {
              className: CLS.number,
              type: 'number',
              min: 0,
              max: 600,
              step: 1,
              value: Math.round((config.minDurationMs ?? 0) / 1000),
              disabled: off,
              'aria-label': t('minDuration'),
              onChange: (event) => {
                const seconds = Number(event.target.value)
                if (!Number.isFinite(seconds)) return
                patch({ minDurationMs: Math.max(0, Math.min(600, seconds)) * 1000 })
              }
            })
          ),
          h(Row, { title: t('sound'), hint: t('sound.hint') },
            h(Switch, {
              checked: config.sound === true,
              disabled: off,
              label: t('sound'),
              onChange: (value) => patch({ sound: value })
            })
          ),
          h(Row, { title: t('subagents'), hint: t('subagents.hint') },
            h(Switch, {
              checked: config.includeSubagents === true,
              disabled: off,
              label: t('subagents'),
              onChange: (value) => patch({ includeSubagents: value })
            })
          )
        ),

        h('div', { className: CLS.actions },
          h('button', {
            type: 'button',
            className: CLS.button + ' ' + CLS.buttonPrimary,
            disabled: off,
            onClick: () => void save()
          }, t('save')),
          h('button', {
            type: 'button',
            className: CLS.button,
            disabled: busy,
            onClick: () => void test()
          }, t('test')),
          notice === '' ? null : h('span', { className: CLS.notice }, notice),
          editable ? null : h('span', { className: CLS.notice }, t('load.readonly'))
        )
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const translate = ctx.locale.bind(NS)
        ensureStyles()
        ctx.effect(() => ctx.locale.register(NS, { zh, ja, en }), 'desktop-notify: dictionaries')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'desktop-notify',
          order: 25,
          // The nav label is a thunk so it follows the active locale; a broken
          // dictionary must not take the settings nav down with it.
          label: () => {
            try {
              return translate('section.title')
            } catch {
              return 'Notifications'
            }
          },
          locale: NS
        }, NotifySettingsPage))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'desktop-notify',
          order: 25
        }, BellIcon))

        // A toast click cannot call into the page, so the Host collects the
        // session the click named and the page drains it here. A click that
        // names nothing — or names a session that no longer exists — leaves the
        // user on whatever the desktop app already brought to the front.
        ctx.effect(() => {
          let stopped = false
          const drain = async () => {
            if (stopped) return
            let target
            try {
              const response = await fetch(PENDING_PATH, { headers: { accept: 'application/json' } })
              if (!response.ok) return
              target = await response.json()
            } catch {
              return
            }
            const session = target?.session
            if (typeof session !== 'string' || session.length === 0) return
            try {
              ctx.get('uiWorkspace')?.openSession?.(session)
            } catch {
              // Unknown or archived session: the window is already in front.
            }
          }
          const timer = window.setInterval(() => void drain(), 800)
          void drain()
          return () => {
            stopped = true
            window.clearInterval(timer)
          }
        }, 'desktop-notify: toast activation')
      }
    }
  }
})
