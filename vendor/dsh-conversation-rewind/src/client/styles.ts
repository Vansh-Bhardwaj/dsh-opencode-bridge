const STYLE_ID = 'dsh-conversation-rewind-styles'

const css = `
.dsh_rewind_view { height: 100%; min-height: 0; overflow: auto; padding: 20px; color: var(--dsw-alias-label-primary); }
.dsh_rewind_panel { display: flex; flex-direction: column; gap: 16px; width: min(100%, 760px); margin: 0 auto; }
.dsh_rewind_intro { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.dsh_rewind_model { padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh_rewind_notice { padding: 18px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-secondary); text-align: center; }
.dsh_rewind_field { display: flex; flex-direction: column; gap: 7px; }
.dsh_rewind_label { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; }
.dsh_rewind_textarea { box-sizing: border-box; width: 100%; min-height: 104px; resize: vertical; padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; background: var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); font: inherit; line-height: 1.5; }
.dsh_rewind_textarea:focus { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dsh_rewind_actions { display: flex; justify-content: flex-end; gap: 8px; }
.dsh_rewind_error { padding: 9px 10px; border-radius: 8px; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); font-size: 12px; line-height: 18px; }
.dsh_rewind_messageAction { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 6px; border: none; border-radius: 28px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dsh_rewind_messageAction:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
[data-dsh-rewind-inline-source] { display: none !important; }
.dsh_rewind_inlineEditor { box-sizing: border-box; display: flex; flex-direction: column; align-self: flex-end; gap: 9px; width: min(525px, 82vw); max-width: 100%; }
.dsh_rewind_inlineActions { display: flex; justify-content: flex-end; gap: 8px; }
.dsh_rewind_treeFrame { --dsh-rewind-tree-bg: var(--dsw-alias-bg-base, transparent); position: relative; background: var(--dsh-rewind-tree-bg); }
.dsh_rewind_treeOrigin { position: relative; display: flex; align-items: center; min-height: 32px; padding-left: 28px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; }
.dsh_rewind_treeOrigin::before { content: ''; position: absolute; left: 8px; top: 50%; width: 8px; height: 8px; border: 2px solid var(--dsw-alias-border-l2); border-radius: 50%; background: var(--dsh-rewind-tree-bg); transform: translateY(-50%); }
.dsh_rewind_treeOrigin::after { content: ''; position: absolute; left: 13px; top: calc(50% + 5px); bottom: -4px; width: 1px; background: var(--dsw-alias-border-l2); }
.dsh_rewind_tree { list-style: none; margin: 0; padding: 8px 0; }
.dsh_rewind_treeItem { position: relative; margin: 0; padding: 0; list-style: none; }
.dsh_rewind_treeChildren { position: relative; list-style: none; margin: 0; padding: 4px 0 4px 30px; }
.dsh_rewind_treeChildren::before { content: ''; position: absolute; left: 13px; top: 0; bottom: 0; width: 1px; background: var(--dsw-alias-border-l2); }
.dsh_rewind_treeChildren > .dsh_rewind_treeItem::before { content: ''; position: absolute; z-index: 2; left: -17px; top: 25px; width: 31px; border-top: 1px solid var(--dsw-alias-border-l2); pointer-events: none; }
.dsh_rewind_treeChildren > .dsh_rewind_treeItem:last-child::after { content: ''; position: absolute; z-index: 3; left: -18px; top: 26px; bottom: 0; width: 3px; background: var(--dsh-rewind-tree-bg); }
/* Keep the semantic tree fully nested while stopping deep branches from
   consuming one more column of width at every level. */
.dsh_rewind_treeChildren[data-compact='true'] { margin-left: -12px; padding-left: 12px; }
.dsh_rewind_treeChildren[data-compact='true']::before { left: 5px; }
.dsh_rewind_treeChildren[data-compact='true'] > .dsh_rewind_treeItem::before { left: -7px; width: 21px; }
.dsh_rewind_treeChildren[data-compact='true'] > .dsh_rewind_treeItem:last-child::after { left: -8px; }
.dsh_rewind_treeNode { position: relative; z-index: 1; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; box-sizing: border-box; width: 100%; min-height: 44px; padding: 8px 10px 8px 22px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: default; }
.dsh_rewind_treeNode::before { content: ''; position: absolute; left: 8px; top: 50%; width: 8px; height: 8px; border: 2px solid var(--dsw-alias-border-l2); border-radius: 50%; background: var(--dsh-rewind-tree-bg); transform: translateY(-50%); }
.dsh_rewind_treeNode[data-actionable='true'] { cursor: pointer; }
.dsh_rewind_treeNode[data-actionable='true']:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh_rewind_treeNode:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dsh_rewind_treeItem[data-current-path='true']::before { border-color: var(--dsw-alias-state-business-primary); }
.dsh_rewind_treeNode[data-current-path='true']::before { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-primary); }
.dsh_rewind_treeNode[data-current='true'] { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); }
.dsh_rewind_treeNode[aria-disabled='true'] { cursor: not-allowed; opacity: .58; }
.dsh_rewind_treeTurn { white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh_rewind_treeText { min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 19px; }
.dsh_rewind_treeBadge { justify-self: end; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); color: var(--dsw-alias-state-business-primary); font-size: 11px; white-space: nowrap; }
[data-dsh-rewind-hidden] { display: none !important; }
@media (max-width: 640px) { .dsh_rewind_view { padding: 12px; } .dsh_rewind_inlineEditor { width: min(100%, 92vw); } .dsh_rewind_treeChildren { padding-left: 22px; } .dsh_rewind_treeChildren::before { left: 9px; } .dsh_rewind_treeChildren > .dsh_rewind_treeItem::before { left: -13px; width: 27px; } .dsh_rewind_treeChildren > .dsh_rewind_treeItem:last-child::after { left: -14px; } .dsh_rewind_treeChildren[data-compact='true'] { margin-left: -8px; padding-left: 8px; } .dsh_rewind_treeChildren[data-compact='true']::before { left: 3px; } .dsh_rewind_treeChildren[data-compact='true'] > .dsh_rewind_treeItem::before { left: -5px; width: 19px; } .dsh_rewind_treeChildren[data-compact='true'] > .dsh_rewind_treeItem:last-child::after { left: -6px; } .dsh_rewind_treeNode { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 7px; padding-left: 20px; } .dsh_rewind_treeTurn { grid-column: 1; grid-row: 1; font-size: 10px; } .dsh_rewind_treeText { grid-column: 1 / -1; grid-row: 2; font-size: 12px; } .dsh_rewind_treeBadge { grid-column: 2; grid-row: 1; } }
`

export function installStyles(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.setAttribute('data-plugin', 'dsh-conversation-rewind')
  style.setAttribute('data-plugin-css', 'dsh-conversation-rewind/base')
  style.textContent = css
  document.head.appendChild(style)
  return () => { style.remove() }
}
