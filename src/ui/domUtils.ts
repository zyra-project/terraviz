// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Small DOM helpers shared across UI modules.
 *
 * Lives in its own file so modules can import escape helpers without
 * pulling in the full browseUI module — keeps the UI modules free of
 * circular dependencies.
 */

/** Escape HTML special characters to prevent XSS in rendered content. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Escape a string for safe use inside an HTML attribute value. */
export function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
