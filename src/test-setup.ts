// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { vi } from 'vitest'

// happy-dom does not implement the Canvas 2D API. Stub it globally so any
// test that constructs a canvas (SphereRenderer glow textures, etc.) doesn't
// blow up on `canvas.getContext('2d')`.
if (typeof HTMLCanvasElement !== 'undefined') {
  const mockCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
    putImageData: vi.fn(),
    createRadialGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    fillRect: vi.fn(),
    fillStyle: '',
  }
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx)
}
