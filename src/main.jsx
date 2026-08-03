import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { useStore } from './store'
import './index.css'

// E2E / manual GUI harnesses attach via CDP and need a stable handle to seed a
// mock session when the local CodeBuddy CLI runtime cannot start.
if (typeof window !== 'undefined') {
    window.__CODEBUDDY_STORE__ = useStore
}

const recentRendererReports = new Map()

function readableError(value) {
    if (value instanceof Error) return value.message || String(value)
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value)
    } catch (_) {
        return String(value)
    }
}

function reportRendererFailure(kind, value, componentStack = '') {
    const error = value instanceof Error ? value : new Error(readableError(value) || 'Unknown renderer error')
    const message = error.message || String(error)
    const stack = error.stack || ''
    const fingerprint = kind + '|' + message + '|' + stack.slice(0, 1000)
    const now = Date.now()
    const previous = recentRendererReports.get(fingerprint) || 0
    if (now - previous < 2000) return
    recentRendererReports.set(fingerprint, now)
    for (const [key, timestamp] of recentRendererReports) {
        if (now - timestamp > 10000) recentRendererReports.delete(key)
    }
    const reportRequest = window.electronAPI?.reportRendererError?.({
        kind,
        message,
        stack,
        componentStack,
        route: window.location.hash || '',
    })
    reportRequest?.catch((reportError) => console.error('Unable to persist renderer error', reportError))
}

if (!window.__codebuddyRendererErrorListenersBound) {
    window.__codebuddyRendererErrorListenersBound = true
    window.addEventListener('error', (event) => {
        if (!event.error && event.target && event.target !== window) {
            const resource = event.target.src || event.target.href || event.target.tagName || 'unknown resource'
            reportRendererFailure('resourceError', new Error('Resource load failed: ' + resource))
            return
        }
        reportRendererFailure('windowError', event.error || new Error(event.message || 'Renderer window error'))
    }, true)
    window.addEventListener('unhandledrejection', (event) => {
        reportRendererFailure('unhandledRejection', event.reason || new Error('Unhandled renderer promise rejection'))
    })
}

class AppErrorBoundary extends React.Component {
    constructor(props) {
        super(props)
        this.state = { error: null, openingDiagnostics: false, actionError: '' }
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    componentDidCatch(error, info) {
        console.error('CodeBuddy Desktop render failed', error, info)
        reportRendererFailure('reactErrorBoundary', error, info?.componentStack || '')
    }

    openDiagnostics = async () => {
        if (this.state.openingDiagnostics) return
        this.setState({ openingDiagnostics: true, actionError: '' })
        try {
            if (!window.electronAPI?.openUserData) throw new Error('诊断目录接口不可用')
            await window.electronAPI.openUserData()
        } catch (error) {
            this.setState({ actionError: error?.message || '打开诊断目录失败' })
        } finally {
            this.setState({ openingDiagnostics: false })
        }
    }

    render() {
        if (!this.state.error) return this.props.children
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-[#111] px-6 text-white">
                <div className="w-full max-w-xl">
                    <div className="text-lg font-semibold">CodeBuddy Desktop 无法加载</div>
                    <div className="mt-2 break-words text-sm text-gray-300">{this.state.error.message || String(this.state.error)}</div>
                    <div className="mt-4 flex flex-wrap gap-2">
                        <button
                            className="rounded bg-blue-600 px-3 py-2 text-sm hover:bg-blue-500"
                            onClick={() => {
                                if (window.electronAPI?.windowReload) window.electronAPI.windowReload()
                                else window.location.reload()
                            }}
                        >
                            重新加载
                        </button>
                        <button className="rounded border border-gray-600 px-3 py-2 text-sm hover:bg-gray-800 disabled:cursor-wait disabled:opacity-60" disabled={this.state.openingDiagnostics} onClick={this.openDiagnostics}>
                            {this.state.openingDiagnostics ? '正在打开...' : '打开诊断目录'}
                        </button>
                    </div>
                    <div className="mt-3 text-xs text-gray-400">错误已写入 crash.log，可在诊断目录中获取。</div>
                    {this.state.actionError ? <div className="mt-2 text-xs text-red-400">{this.state.actionError}</div> : null}
                </div>
            </div>
        )
    }
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <AppErrorBoundary>
            <App />
        </AppErrorBoundary>
    </React.StrictMode>
)
