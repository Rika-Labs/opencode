import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"

export interface MessageTarget {
  postMessage(message: unknown, targetOrigin: string): void
}

export interface MessageEvents {
  addEventListener(type: "message", listener: (event: Event) => void): void
  removeEventListener(type: "message", listener: (event: Event) => void): void
}

export interface IframeTransportOptions {
  target: MessageTarget
  source: object
  origin: string
  events?: MessageEvents
}

export class IframeTransport implements Transport {
  private readonly target: MessageTarget
  private readonly source: object
  private readonly origin: string
  private readonly events: MessageEvents | undefined
  private readonly listener: (event: Event) => void

  constructor(options: IframeTransportOptions) {
    this.target = options.target
    this.source = options.source
    this.origin = options.origin
    this.events = options.events
    this.listener = (event: Event) => {
      const message = event as MessageEvent
      if (message.source !== this.source) return
      if (message.origin !== this.origin) return
      const parsed = JSONRPCMessageSchema.safeParse(message.data)
      if (parsed.success) {
        this.onmessage?.(parsed.data)
        return
      }
      this.onerror?.(new Error(`Invalid JSON-RPC message received: ${parsed.error.message}`))
    }
  }

  async start(): Promise<void> {
    this.host()?.addEventListener("message", this.listener)
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.target.postMessage(message, this.origin === "null" ? "*" : this.origin)
  }

  async close(): Promise<void> {
    this.host()?.removeEventListener("message", this.listener)
    this.onclose?.()
  }

  private host(): MessageEvents | undefined {
    if (this.events) return this.events
    if (typeof window !== "undefined") return window
    return undefined
  }

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void
  sessionId?: string
  setProtocolVersion?: (version: string) => void
}
