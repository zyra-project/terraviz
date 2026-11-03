// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Can this browser render the globe at all?
 *
 * Split out of `main.ts`'s `checkWebGLSupport()` so the question has an
 * answer a test can reach: `main.ts` exports nothing and boots on import,
 * so the predicate was previously only reachable by driving the whole
 * `DOMContentLoaded` path — which is why the test named for it
 * re-implemented the expression locally and asserted against its own copy
 * rather than the shipped one. A copy of a predicate passes whatever the
 * original does.
 *
 * **WebGL 2 specifically, and there is deliberately no WebGL 1 fallback.**
 * MapLibre 6 dropped WebGL 1 outright — its `canvasContextAttributes`
 * types `contextType` as the literal `'webgl2'` and nothing else — and the
 * value readout (`glLumaSampler`) has always needed 2. Accepting a
 * WebGL-1-only context would clear this preflight and then fail inside the
 * renderer, which costs the user the troubleshooting screen `main.ts`
 * draws on a `false` return: the one place the app explains what to do.
 * A blank globe and no explanation is the worse of the two failures.
 *
 * The canvas comes in through a factory so a test can supply one without a
 * document, and so a stubbed `getContext` cannot leak between cases.
 * Context creation throws on some drivers rather than returning null, so
 * the call is guarded — a browser that throws here has no WebGL 2 either.
 */
export function hasWebGL2(
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): boolean {
  try {
    return createCanvas().getContext('webgl2') != null
  } catch {
    return false
  }
}

/**
 * Replace the loading screen with the troubleshooting screen a `false`
 * from {@link hasWebGL2} leads to. Here rather than in `main.ts` so the
 * part with a wrong answer — how it is announced — is reachable from a
 * test.
 *
 * The loading screen is not a live region, and this replaces the
 * status line that is, so the message announces itself: `role="alert"`
 * is spoken when it is inserted, where a polite region created already
 * holding its text is not. Assertive because the app cannot start and
 * nothing else on the page is current. Only the two lines that say so
 * are inside it, not the fix-it steps, which a reader opens when they
 * want them: a closed `<details>` would add only "How to fix this,
 * collapsed".
 *
 * The text is English in every locale, so it is marked `lang="en"`:
 * under a translated `<html lang>` a screen reader would otherwise speak
 * it with that language's voice. Drop the attribute when the strings go
 * through `t()`.
 */
export function showWebGLUnavailable(screen: HTMLElement): void {
  screen.innerHTML = `
    <div lang="en" style="max-width:480px;padding:2rem;text-align:center;color:#e0e0e0;font-family:system-ui,sans-serif;">
      <div style="font-size:2.5rem;margin-bottom:0.75rem;" aria-hidden="true">&#x1F30D;</div>
      <div role="alert">
        <h1 style="font-size:1.1rem;margin:0 0 0.75rem;color:#fff;">WebGL 2 is not available</h1>
        <p style="font-size:0.8rem;line-height:1.5;color:#aaa;margin:0 0 1.25rem;">
          This application requires WebGL 2 to render the interactive globe.
          Your browser's GPU acceleration appears to be disabled.
        </p>
      </div>
      <details style="text-align:start;font-size:0.75rem;color:#999;line-height:1.6;">
        <summary style="cursor:pointer;color:#4da6ff;margin-bottom:0.5rem;">How to fix this</summary>
        <ol style="padding-inline-start:1.25rem;margin:0;">
          <li>Open <strong style="color:#fff;">chrome://flags</strong> in your address bar</li>
          <li>Search for <strong style="color:#fff;">Override software rendering list</strong></li>
          <li>Set it to <strong style="color:#fff;">Enabled</strong> and relaunch Chrome</li>
        </ol>
        <p style="margin:0.75rem 0 0.25rem;color:#888;">Alternatively, launch Chrome from the terminal with:</p>
        <code style="display:block;background:#1a1a2e;padding:0.5rem 0.75rem;border-radius:4px;color:#4da6ff;font-size:0.7rem;overflow-x:auto;">
          google-chrome --ignore-gpu-blocklist --enable-unsafe-swiftshader
        </code>
        <p style="margin:0.75rem 0 0;color:#888;">
          If the problem persists, check <strong style="color:#fff;">chrome://gpu</strong>
          for driver issues. Installing or updating your GPU drivers
          (e.g. <code style="color:#ccc;">sudo apt install nvidia-driver-xxx</code>
          or <code style="color:#ccc;">mesa-utils</code>) usually resolves this.
        </p>
      </details>
    </div>`
  screen.style.display = 'flex'
  screen.style.alignItems = 'center'
  screen.style.justifyContent = 'center'
  screen.classList.remove('fade-out')
}
