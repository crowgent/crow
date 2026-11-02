import type { StreamChunk } from "../types/index";
import { containsEncryptedReasoning } from "./reasoning";

export class ThoughtTracker {
  private capturedReasoning = "";
  private emitted = 0;
  private preview = "";
  private encryptedHidden = false;
  private startMs = 0;
  private doneMs: number | null = null;

  capture(text: string): void {
    this.capturedReasoning += text;
  }

  hasReasoning(): boolean {
    return this.capturedReasoning.length > 0;
  }

  reset(): void {
    this.capturedReasoning = "";
    this.emitted = 0;
    this.preview = "";
    this.encryptedHidden = false;
    this.startMs = 0;
    this.doneMs = null;
  }

  start(): void {
    if (this.startMs === 0) {
      this.startMs = Date.now();
    }
  }

  noteStreamPart(type: string): void {
    if (
      this.doneMs == null &&
      (type === "text-delta" || type === "tool-call" || type === "tool-result" || type === "error")
    ) {
      this.doneMs = Date.now();
    }
  }

  *emitFresh(): Generator<StreamChunk> {
    if (this.emitted < this.capturedReasoning.length) {
      const fresh = this.capturedReasoning.slice(this.emitted);
      this.emitted = this.capturedReasoning.length;
      yield* this.emit(fresh);
    }
  }

  *emitText(text: string): Generator<StreamChunk> {
    yield* this.emit(text);
  }

  private *emit(text: string): Generator<StreamChunk> {
    this.preview = `${this.preview}${text}`.slice(-256);
    if (containsEncryptedReasoning(this.preview)) {
      if (!this.encryptedHidden) {
        this.encryptedHidden = true;
        yield { type: "reasoning", content: "[Encrypted reasoning hidden]" };
      }
      return;
    }
    yield { type: "reasoning", content: text };
  }

  finish(): { durationMs: number; text: string } | undefined {
    const durationMs = this.startMs > 0 ? (this.doneMs ?? Date.now()) - this.startMs : undefined;
    if (durationMs == null) {
      return undefined;
    }
    return { durationMs, text: this.capturedReasoning.trim() };
  }
}
