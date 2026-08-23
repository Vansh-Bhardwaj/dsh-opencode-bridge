window.__ModuleLoader__.load({
  id: "@local/dsh-plugin-ocui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");

    var FAMILY_RULES = [
      [/^claude/, 'Claude'],
      [/^(gpt|o\d|codex)/, 'GPT / OpenAI'],
      [/^gemini/, 'Gemini'],
      [/^kimi/, 'Kimi'],
      [/^glm/, 'GLM'],
      [/^qwen/, 'Qwen'],
      [/deepseek/, 'DeepSeek'],
      [/^(minimax|mimo)/, 'MiniMax'],
      [/^grok/, 'Grok'],
      [/^(nemotron|hy3|bigpickle|big-pickle)/, 'Free & Community']
    ];

    function familyOf(model) {
      var s = String((model && (model.id || model.name)) || '').toLowerCase();
      for (var i = 0; i < FAMILY_RULES.length; i++) {
        if (FAMILY_RULES[i][0].test(s)) return FAMILY_RULES[i][1];
      }
      return 'Other';
    }

    function groupIntoFamilies(group) {
      var order = [];
      var map = {};
      for (var i = 0; i < group.models.length; i++) {
        var m = group.models[i];
        var f = familyOf(m);
        if (!map[f]) { map[f] = []; order.push(f); }
        map[f].push(m);
      }
      return order.map(function (name) { return { name: name, models: map[name] }; });
    }

    var CSS = [
      '.ocms-root,.ocms-root *,.oc-usageRoot,.oc-usageRoot *{box-sizing:border-box}',
      '.ocms-root{min-width:0;position:relative}',
      '.ocms-trigger{font-family:inherit;min-width:min(224px,42cqw);max-width:min(300px,45cqw);height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);border:none;border-radius:16px;outline:none;align-items:center;gap:4px;padding:0 8px 0 10px;font-size:13px;line-height:20px;display:flex}',
      '.ocms-trigger:hover:not(:disabled),.ocms-trigger[aria-expanded="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-pressed,var(--dsw-alias-interactive-bg-hover))}',
      '.ocms-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.ocms-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.ocms-triggerCopy{min-width:0;flex:1;display:flex;justify-content:center;align-items:center;gap:5px;padding-left:14px}',
      '.ocms-triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden;font-weight:600}',
      '.ocms-triggerEffort{color:var(--dsw-alias-label-caption);font-weight:400;flex:none}',
      '.ocms-chev{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s;display:flex}',
      '.ocms-chevOpen{transform:rotate(180deg)}',
      '.ocms-menu{z-index:40;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:max-content;min-width:min(224px,calc(100vw - 32px));max-width:min(360px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 6px);right:0;overflow:hidden}',
      '.ocms-status,.ocms-empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}',
      '.ocms-error{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px}',
      '.ocms-cell{font-family:inherit;display:flex;align-items:center;gap:7px;width:100%;min-height:36px;text-align:left;background:transparent;border:none;cursor:pointer;color:inherit;border-radius:8px;padding:7px 9px;font-size:13px;font-weight:400;line-height:20px}',
      '.ocms-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ocms-cellLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ocms-cellValue{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none;max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ocms-back{border-bottom:1px solid var(--dsw-alias-border-l3);border-radius:7px 7px 0 0;margin-bottom:3px}',
      '.ocms-divider{height:1px;background:var(--dsw-alias-border-l3);margin:4px 7px}',
      '.ocms-groups{overflow-y:auto;display:flex;flex-direction:column;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}',
      '.ocms-familyTitle{color:var(--dsw-alias-label-caption);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:10px 10px 4px;user-select:none}',
      '.ocms-option{font-family:inherit;display:flex;align-items:center;gap:8px;width:100%;min-height:38px;text-align:left;background:transparent;border:none;cursor:pointer;color:inherit;border-radius:10px;padding:6px 10px;font-size:13px;line-height:18px}',
      '.ocms-option:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ocms-optionCopy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.ocms-modelName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ocms-desc{color:var(--dsw-alias-label-caption);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ocms-check{flex:none;width:16px;display:flex;color:var(--dsw-alias-label-primary)}',
      '.ocms-count{color:var(--dsw-alias-label-caption);font-size:11px;flex:none}',
      '.oc-usageRoot{--oc-blue:#5277ff;--oc-green:var(--dsw-alias-state-success-primary);--oc-warn:var(--dsw-alias-state-warn-primary);--oc-red:var(--dsw-alias-state-error-primary);width:100%;position:relative;color:var(--dsw-alias-label-primary);font-family:inherit}',
      '.oc-usageTrigger{font-family:inherit;width:100%;height:42px;display:flex;align-items:center;gap:8px;padding:0 10px 0 8px;color:var(--dsw-alias-label-primary);cursor:pointer;background:transparent;border:0;border-radius:12px;text-align:left;outline:none}',
      '.oc-usageTrigger:hover,.oc-usageTrigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.oc-usageTrigger:focus-visible,.oc-refresh:focus-visible,.oc-close:focus-visible,.oc-retry:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.oc-brandLogo{width:20px;height:20px;display:block;flex:none;border-radius:3px;overflow:hidden}',
      '.oc-brandLogo svg{width:100%;height:100%;display:block}',
      '.oc-usageCopy{min-width:0;flex:1;display:flex;flex-direction:column;gap:0}',
      '.oc-usageTitle{font-size:14px;font-weight:500;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.oc-usageSummary{color:var(--dsw-alias-label-caption);font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.oc-usagePct{font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--oc-blue);flex:none}',
      '.oc-usageCompact{width:40px;padding:0;justify-content:center}',
      '.oc-usagePanel{position:absolute;z-index:80;left:0;bottom:calc(100% + 8px);width:100%;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;padding:4px;color:var(--dsw-alias-label-primary);overflow:hidden}',
      '.oc-usagePanelCompact{position:fixed;left:52px;bottom:52px;width:min(316px,calc(100vw - 68px))}',
      '.oc-panelHeader{display:flex;align-items:center;gap:8px;height:48px;padding:5px 6px 5px 8px}',
      '.oc-panelHeading{flex:1;min-width:0}',
      '.oc-panelTitle{font-size:14px;font-weight:600;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.oc-panelSub{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:15px;white-space:nowrap}',
      '.oc-statusDot{width:6px;height:6px;border-radius:50%;background:var(--oc-green);flex:none}',
      '.oc-refresh,.oc-close{font-family:inherit;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);display:grid;place-items:center;cursor:pointer;outline:none}',
      '.oc-refresh:hover,.oc-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.oc-refresh:disabled{cursor:default;opacity:.55}',
      '.oc-spin{animation:oc-spin .8s linear infinite}',
      '.oc-windowList{display:flex;flex-direction:column;padding:0 8px 3px}',
      '.oc-window{padding:8px 2px}',
      '.oc-window+.oc-window{border-top:1px solid var(--dsw-alias-border-l3)}',
      '.oc-windowTop{display:flex;align-items:baseline;gap:7px;margin-bottom:5px}',
      '.oc-windowName{font-size:13px;font-weight:500;line-height:18px}',
      '.oc-windowStatus{margin-left:auto;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
      '.oc-windowPct{font-size:12px;font-weight:600;line-height:17px;font-variant-numeric:tabular-nums;color:var(--oc-accent)}',
      '.oc-track{height:4px;overflow:hidden;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover)}',
      '.oc-fill{height:100%;border-radius:inherit;background:var(--oc-accent);transition:width .2s cubic-bezier(.22,1,.36,1)}',
      '.oc-reset{margin-top:5px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:15px}',
      '.oc-panelFooter{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l3);margin:0 6px;padding:8px 2px 5px;color:var(--dsw-alias-label-caption);font-size:10px;line-height:14px}',
      '.oc-protection{display:flex;align-items:center;gap:7px;margin:2px 8px 0;padding:8px 2px;border-top:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
      '.oc-protection strong{color:var(--dsw-alias-label-secondary);font-weight:500}.oc-protectionDot{width:6px;height:6px;border-radius:50%;background:var(--oc-green);flex:none}',
      '.oc-manageLink{color:var(--dsw-alias-label-secondary);text-decoration:none;white-space:nowrap}.oc-manageLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
      '.oc-loading{padding:8px 10px 12px;display:flex;flex-direction:column;gap:9px}',
      '.oc-skeleton{height:46px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);opacity:.75}',
      '.oc-error{padding:16px 12px 14px;text-align:center}',
      '.oc-errorTitle{font-size:13px;font-weight:600;margin-bottom:4px}',
      '.oc-errorCopy{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '.oc-retry{font-family:inherit;margin-top:11px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 10px;font-size:12px;cursor:pointer}',
      '.oc-retry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '@keyframes oc-spin{to{transform:rotate(360deg)}}',
      '@media (max-width:720px){.oc-usagePanel{position:fixed;left:12px;right:12px;bottom:12px;width:auto}}',
      '@media (prefers-reduced-motion:reduce){.ocms-chev,.oc-fill{transition:none}.oc-spin{animation:none}}'
    ].join('\n');

    var STYLE_ID = '@local/dsh-plugin-ocui/client.css';
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) {
      var styleTag = document.createElement('style');
      styleTag.setAttribute('data-plugin-css', STYLE_ID);
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
    }

    function ChevronDown() {
      return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M4 6l4 4 4-4' }));
    }
    function ChevronRight() {
      return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M6 4l4 4-4 4' }));
    }
    function ChevronLeft() {
      return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M10 4L6 8l4 4' }));
    }
    function CheckIcon() {
      return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M3 8.5l3.5 3.5L13 5' }));
    }

    function OpenCodeLogo() {
      return React.createElement('span', { className: 'oc-brandLogo', 'aria-hidden': true },
        React.createElement('svg', { viewBox: '0 0 512 512', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
          React.createElement('rect', { width: 512, height: 512, fill: '#131010' }),
          React.createElement('path', { d: 'M320 224V352H192V224H320Z', fill: '#5A5858' }),
          React.createElement('path', { fillRule: 'evenodd', clipRule: 'evenodd', d: 'M384 416H128V96H384V416ZM320 160H192V352H320V160Z', fill: 'white' })));
    }

    function GroupedModelSelect(props) {
      var locked = props.locked;
      var available = props.available;
      var directory = props.directory;
      var load = props.load;
      var select = props.select;
      var state = React.useSyncExternalStore(function (fn) { return directory.subscribe(fn); }, function () { return directory.getSnapshot(); });
      var openR = React.useState(false); var open = openR[0]; var setOpen = openR[1];
      var paneR = React.useState('root'); var pane = paneR[0]; var setPane = paneR[1];
      var errR = React.useState(null); var err = errR[0]; var setErr = errR[1];
      var rootRef = React.useRef(null);
      var triggerRef = React.useRef(null);
      var itemRefs = React.useRef([]);

      var visibleGroups = React.useMemo(function () {
        return state.groups.filter(function (group) {
          var id = String(group.id || '').toLowerCase();
          var name = String(group.name || '').toLowerCase();
          return id !== 'deepseek' && id !== 'llm-deepseek' && name !== 'deepseek';
        });
      }, [state.groups]);

      var choices = React.useMemo(function () {
        var out = [];
        for (var i = 0; i < visibleGroups.length; i++) {
          var g = visibleGroups[i];
          for (var j = 0; j < g.models.length; j++) {
            out.push({ group: g, model: g.models[j], selection: { provider: g.id, model: g.models[j].id } });
          }
        }
        return out;
      }, [visibleGroups]);

      var curIndex = state.current === null ? -1 : choices.findIndex(function (c) {
        return c.selection.provider === state.current.provider && c.selection.model === state.current.model;
      });
      var currentChoice = curIndex >= 0 ? choices[curIndex] : undefined;
      var reasoning = currentChoice ? currentChoice.model.reasoning : undefined;
      var effectiveEffort = (state.current && state.current.reasoningEffort !== undefined) ? state.current.reasoningEffort : (reasoning ? reasoning.defaultEffort : undefined);
      var effortLabel = reasoning === undefined ? undefined : (effectiveEffort === undefined ? 'Default' : ((reasoning.efforts.find(function (l) { return l.id === effectiveEffort; }) || {}).name || effectiveEffort));
      var busy = state.status === 'selecting';

      React.useEffect(function () { if (available) load(); }, [available, load]);
      React.useEffect(function () {
        if (!open) return;
        var closeOutside = function (event) { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false); };
        document.addEventListener('mousedown', closeOutside);
        return function () { document.removeEventListener('mousedown', closeOutside); };
      }, [open]);

      if (!available) return null;

      var show = function () { setPane('root'); setErr(null); setOpen(true); load(); };
      var close = function (restoreFocus) {
        setOpen(false); setPane('root');
        if (restoreFocus) queueMicrotask(function () { if (triggerRef.current) triggerRef.current.focus(); });
      };
      var moveFocus = function (offset) {
        var items = itemRefs.current.filter(function (n) { return n !== null; });
        if (!items.length) return;
        var active = items.indexOf(document.activeElement);
        var next = items[(Math.max(active, 0) + offset + items.length) % items.length];
        if (next) next.focus();
      };
      var onKeyDown = function (event) {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          if (pane !== 'root') setPane('root'); else close(true);
          return;
        }
        if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          moveFocus(event.key === 'ArrowDown' ? 1 : -1);
        }
      };
      var choose = function (selection) {
        if (state.current && state.current.provider === selection.provider && state.current.model === selection.model) { close(true); return; }
        setErr(null);
        select(selection).then(function (ok) { if (ok) close(true); }).catch(function (e) { setErr(String((e && e.message) || e)); });
      };
      var chooseEffort = function (effort) {
        if (!state.current) return;
        if (effectiveEffort === effort) { close(true); return; }
        var selection = { provider: state.current.provider, model: state.current.model };
        if (effort !== undefined) selection.reasoningEffort = effort;
        setErr(null);
        select(selection).then(function (ok) { if (ok) close(true); }).catch(function (e) { setErr(String((e && e.message) || e)); });
      };

      var modelLabel = currentChoice ? currentChoice.model.name : 'Select model';
      var triggerLabel = effortLabel === undefined ? modelLabel : (modelLabel + ' · ' + effortLabel);
      itemRefs.current = [];
      var itemIndex = 0;
      var itemRef = function () {
        var at = itemIndex++;
        return function (node) { itemRefs.current[at] = node; };
      };

      var children = [
        React.createElement('button', {
          key: 'trigger', ref: triggerRef, type: 'button', className: 'ocms-trigger',
          'aria-label': 'Select model', 'aria-haspopup': 'menu', 'aria-expanded': open,
          title: triggerLabel, disabled: locked,
          onClick: function () { if (open) close(); else show(); }
        },
          React.createElement('span', { className: 'ocms-triggerCopy' },
            React.createElement('span', { className: 'ocms-triggerLabel' }, modelLabel),
            effortLabel !== undefined ? React.createElement('span', { className: 'ocms-triggerEffort' }, effortLabel) : null),
          React.createElement('span', { className: 'ocms-chev' + (open ? ' ocms-chevOpen' : '') }, React.createElement(ChevronDown, null))
        )
      ];

      if (open) {
        var menuChildren = [];
        if (err) menuChildren.push(React.createElement('div', { key: 'err', className: 'ocms-error' }, err));

        if (pane === 'root') {
          if (state.status === 'loading' && visibleGroups.length === 0) {
            menuChildren.push(React.createElement('div', { key: 'ld', className: 'ocms-status' }, 'Refreshing model list…'));
          }
          menuChildren.push(React.createElement('button', {
            key: 'model', ref: itemRef(), type: 'button', role: 'menuitem', className: 'ocms-cell',
            onClick: function () { setPane(currentChoice ? currentChoice.group.id : 'providers'); }
          },
            React.createElement('span', { className: 'ocms-cellLabel' }, 'Model'),
            React.createElement('span', { className: 'ocms-cellValue' }, modelLabel),
            React.createElement('span', { className: 'ocms-chev' }, React.createElement(ChevronRight, null))));
          if (reasoning !== undefined) {
            menuChildren.push(React.createElement('button', {
              key: 'effort', ref: itemRef(), type: 'button', role: 'menuitem', className: 'ocms-cell',
              onClick: function () { setPane('effort'); }
            },
              React.createElement('span', { className: 'ocms-cellLabel' }, 'Effort'),
              React.createElement('span', { className: 'ocms-cellValue' }, effortLabel || 'Default'),
              React.createElement('span', { className: 'ocms-chev' }, React.createElement(ChevronRight, null))));
          }
          menuChildren.push(React.createElement('div', { key: 'divider', className: 'ocms-divider' }));
          menuChildren.push(React.createElement('button', {
            key: 'provider', ref: itemRef(), type: 'button', role: 'menuitem', className: 'ocms-cell',
            onClick: function () { setPane('providers'); }
          },
            React.createElement('span', { className: 'ocms-cellLabel' }, 'Provider'),
            React.createElement('span', { className: 'ocms-cellValue' }, currentChoice ? currentChoice.group.name : 'Choose'),
            React.createElement('span', { className: 'ocms-chev' }, React.createElement(ChevronRight, null))));
          if (state.status === 'ready' && choices.length === 0) {
            menuChildren.push(React.createElement('div', { key: 'empty', className: 'ocms-empty' }, 'No models available.'));
          }
        } else if (pane === 'providers') {
          menuChildren.push(React.createElement('button', {
            key: 'back', ref: itemRef(), type: 'button', role: 'menuitem', className: 'ocms-cell ocms-back',
            onClick: function () { setPane('root'); }
          }, React.createElement('span', { className: 'ocms-chev' }, React.createElement(ChevronLeft, null)), React.createElement('span', { className: 'ocms-cellLabel' }, 'Provider')));
          for (var gi = 0; gi < visibleGroups.length; gi++) {
            (function (group) {
              menuChildren.push(React.createElement('button', {
                key: 'g-' + group.id, ref: itemRef(), type: 'button', role: 'menuitem', className: 'ocms-cell',
                onClick: function () { setPane(group.id); }
              },
                React.createElement('span', { className: 'ocms-cellLabel' }, group.name),
                React.createElement('span', { className: 'ocms-count' }, String(group.models.length)),
                React.createElement('span', { className: 'ocms-chev' }, React.createElement(ChevronRight, null))
              ));
            })(visibleGroups[gi]);
          }
          if (state.failures && state.failures.length) {
            for (var fi = 0; fi < state.failures.length; fi++) {
              if (String(state.failures[fi].name || '').toLowerCase() !== 'deepseek') {
                menuChildren.push(React.createElement('div', { key: 'f-' + state.failures[fi].id, className: 'ocms-status' }, state.failures[fi].name + ' failed to load'));
              }
            }
          }
        } else if (pane === 'effort') {
          menuChildren.push(React.createElement('button', {
            key: 'back', ref: itemRef(), type: 'button', role: 'menuitem', className: 'ocms-cell ocms-back',
            onClick: function () { setPane('root'); }
          }, React.createElement('span', { className: 'ocms-chev' }, React.createElement(ChevronLeft, null)), React.createElement('span', { className: 'ocms-cellLabel' }, 'Back')));
          var levels = [];
          if (reasoning) {
            if (reasoning.defaultEffort === undefined) levels.push({ key: 'provider-default', effort: undefined, label: 'Default' });
            for (var li = 0; li < reasoning.efforts.length; li++) levels.push({ key: 'effort:' + reasoning.efforts[li].id, effort: reasoning.efforts[li].id, label: reasoning.efforts[li].name });
          }
          if (!levels.length) {
            menuChildren.push(React.createElement('div', { key: 'ne', className: 'ocms-empty' }, 'This model provides no reasoning effort levels.'));
          }
          for (var ei = 0; ei < levels.length; ei++) {
            (function (level) {
              menuChildren.push(React.createElement('button', {
                key: level.key, ref: itemRef(), type: 'button', role: 'menuitemradio', 'aria-checked': effectiveEffort === level.effort,
                className: 'ocms-option', disabled: busy,
                onClick: function () { chooseEffort(level.effort); }
              },
                React.createElement('span', { className: 'ocms-optionCopy' }, React.createElement('span', { className: 'ocms-modelName' }, level.label)),
                React.createElement('span', { className: 'ocms-check' }, effectiveEffort === level.effort ? React.createElement(CheckIcon, null) : null)
              ));
            })(levels[ei]);
          }
        } else {
          var group = null;
          for (var gj = 0; gj < visibleGroups.length; gj++) if (visibleGroups[gj].id === pane) group = visibleGroups[gj];
          if (!group) { setPane('root'); }
          else {
            menuChildren.push(React.createElement('button', {
              key: 'back', ref: itemRef(), type: 'button', role: 'menuitem', className: 'ocms-cell ocms-back',
              onClick: function () { setPane('root'); }
            }, React.createElement('span', { className: 'ocms-chev' }, React.createElement(ChevronLeft, null)), React.createElement('span', { className: 'ocms-cellLabel' }, group.name)));
            var families = groupIntoFamilies(group);
            for (var ki = 0; ki < families.length; ki++) {
              var fam = families[ki];
              menuChildren.push(React.createElement('div', { key: 'fam-' + fam.name, className: 'ocms-familyTitle' }, fam.name + ' (' + fam.models.length + ')'));
              for (var mi = 0; mi < fam.models.length; mi++) {
                (function (model) {
                  var selected = !!(state.current && state.current.provider === group.id && state.current.model === model.id);
                  menuChildren.push(React.createElement('button', {
                    key: model.id, ref: itemRef(), type: 'button', role: 'menuitemradio', 'aria-checked': selected,
                    className: 'ocms-option', title: model.name, disabled: busy,
                    onClick: function () { choose({ provider: group.id, model: model.id }); }
                  },
                    React.createElement('span', { className: 'ocms-optionCopy' },
                      React.createElement('span', { className: 'ocms-modelName' }, model.name),
                      model.description !== undefined ? React.createElement('span', { className: 'ocms-desc' }, model.description) : null),
                    React.createElement('span', { className: 'ocms-check' }, selected ? React.createElement(CheckIcon, null) : null)
                  ));
                })(fam.models[mi]);
              }
            }
          }
        }

        children.push(React.createElement('div', {
          key: 'menu', className: 'ocms-menu', role: 'menu', 'aria-busy': state.status === 'loading' || busy
        },
          React.createElement('div', { key: 'panes', className: 'ocms-groups' }, menuChildren)
        ));
      }

      return React.createElement('div', { ref: rootRef, className: 'ocms-root', onKeyDown: onKeyDown }, children);
    }

    function fmtReset(iso) {
      try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso || ''); }
    }

    function fmtRelative(iso, now) {
      var target = new Date(iso).getTime();
      if (!Number.isFinite(target)) return 'Reset time unavailable';
      var ms = target - now;
      if (ms <= 0) return 'Resetting now';
      var minutes = Math.ceil(ms / 60000);
      if (minutes < 60) return 'Resets in ' + minutes + 'm';
      var hours = Math.floor(minutes / 60);
      var mins = minutes % 60;
      if (hours < 48) return 'Resets in ' + hours + 'h' + (mins ? ' ' + mins + 'm' : '');
      var days = Math.floor(hours / 24);
      var remHours = hours % 24;
      return 'Resets in ' + days + 'd' + (remHours ? ' ' + remHours + 'h' : '');
    }

    function accentFor(percent, status) {
      if (status && status !== 'ok') return 'var(--oc-red)';
      if (percent >= 85) return 'var(--oc-red)';
      if (percent >= 60) return 'var(--oc-warn)';
      return 'var(--oc-blue)';
    }

    function RefreshIcon() {
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M13 3v4H9' }),
        React.createElement('path', { d: 'M12.1 10.8A5.5 5.5 0 1 1 13 7' }));
    }

    function CloseIcon() {
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
        React.createElement('path', { d: 'M4 4l8 8M12 4l-8 8' }));
    }

    var PLUGIN_CTX = null;

    function UsageBadge(props) {
      var wide = props.wide;
      var stR = React.useState({ loading: true });
      var state = stR[0]; var setState = stR[1];
      var openR = React.useState(false); var open = openR[0]; var setOpen = openR[1];
      var tickR = React.useState(Date.now()); var now = tickR[0]; var setNow = tickR[1];
      var rootRef = React.useRef(null);
      var refresh = React.useCallback(function () {
        setState(function (prev) {
          return Object.assign({}, prev, { loading: !prev.ok, refreshing: !!prev.ok });
        });
        var connection = PLUGIN_CTX && PLUGIN_CTX.connection;
        if (!connection || !connection.rpc) {
          setState({ ok: false, loading: false, refreshing: false, error: 'Connection unavailable' });
          return Promise.resolve();
        }
        return Promise.all([
          connection.rpc.call('/ocui', 'usage', null),
          connection.rpc.call('/ocui', 'status', null).catch(function () { return null; })
        ]).then(function (results) {
          var r = results[0]; var status = results[1];
          if (r && r.ok && r.value && r.value.ok) {
            setState(Object.assign({}, r.value, { bridge: status && status.ok && status.value && status.value.ok ? status.value : null, loading: false, refreshing: false, updatedAt: Date.now() }));
          } else {
            var detail = (r && r.value && r.value.error) || (r && r.error && (r.error.message || r.error.code)) || 'Usage request failed';
            setState({ ok: false, loading: false, refreshing: false, error: detail });
          }
        }).catch(function (e) { setState({ ok: false, loading: false, refreshing: false, error: String((e && e.message) || e) }); });
      }, []);
      React.useEffect(function () {
        refresh();
        if (!PLUGIN_CTX || !PLUGIN_CTX.interval) return undefined;
        return PLUGIN_CTX.interval(refresh, 60000);
      }, [refresh]);
      React.useEffect(function () {
        if (!PLUGIN_CTX || !PLUGIN_CTX.interval) return undefined;
        return PLUGIN_CTX.interval(function () { setNow(Date.now()); }, 30000);
      }, []);
      React.useEffect(function () {
        if (!open) return undefined;
        var onPointer = function (event) { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false); };
        var onKey = function (event) { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onPointer);
        document.addEventListener('keydown', onKey);
        return function () {
          document.removeEventListener('mousedown', onPointer);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      var specs = [
        { key: 'rolling', label: '5-hour window' },
        { key: 'weekly', label: 'Weekly limit' },
        { key: 'monthly', label: 'Monthly limit' }
      ];
      var windows = [];
      var worst = 0;
      if (state && state.ok && state.usage) {
        for (var si = 0; si < specs.length; si++) {
          var entry = state.usage[specs[si].key];
          if (!entry) continue;
          var percent = Math.max(0, Math.min(100, Number(entry.percent) || 0));
          if (percent > worst) worst = percent;
          windows.push({ key: specs[si].key, label: specs[si].label, percent: percent, status: entry.status || 'ok', resetsAt: entry.resetsAt });
        }
      }
      var accent = state.ok ? accentFor(worst, 'ok') : '#85858d';
      var summary = state.loading ? 'Checking limits…' : (state.ok ? (windows.length + ' limits · protected') : 'Usage unavailable');
      var tip = state.ok ? ('OpenCode Go · ' + worst + '% highest usage') : ('OpenCode Go' + (state.error ? ': ' + state.error : ''));

      var trigger = React.createElement('button', {
        type: 'button', className: 'oc-usageTrigger' + (wide ? '' : ' oc-usageCompact'),
        title: tip, 'aria-label': 'OpenCode Go usage limits', 'aria-haspopup': 'dialog', 'aria-expanded': open,
        onClick: function () { setOpen(!open); },
        style: { '--oc-accent': accent }
      },
        React.createElement(OpenCodeLogo, null),
        wide ? React.createElement('span', { className: 'oc-usageCopy' },
          React.createElement('span', { className: 'oc-usageTitle' }, 'OpenCode Go'),
          React.createElement('span', { className: 'oc-usageSummary' }, summary)) : null,
        wide && state.ok ? React.createElement('span', { className: 'oc-usagePct' }, worst + '%') : null
      );

      var panel = null;
      if (open) {
        var body;
        if (state.loading) {
          body = React.createElement('div', { className: 'oc-loading', 'aria-label': 'Loading usage limits' },
            React.createElement('div', { className: 'oc-skeleton' }),
            React.createElement('div', { className: 'oc-skeleton' }),
            React.createElement('div', { className: 'oc-skeleton' }));
        } else if (!state.ok) {
          body = React.createElement('div', { className: 'oc-error' },
            React.createElement('div', { className: 'oc-errorTitle' }, 'Couldn\'t load usage'),
            React.createElement('div', { className: 'oc-errorCopy' }, state.error || 'OpenCode did not return limit data.'),
            React.createElement('button', { type: 'button', className: 'oc-retry', onClick: refresh }, 'Try again'));
        } else {
          body = React.createElement('div', { className: 'oc-windowList' }, windows.map(function (item) {
            var itemAccent = accentFor(item.percent, item.status);
            var statusLabel = item.status !== 'ok' || item.percent >= 100 ? 'Limit reached' : (item.percent >= 85 ? 'Almost used' : (item.percent >= 60 ? 'Getting close' : 'Available'));
            return React.createElement('div', { key: item.key, className: 'oc-window', style: { '--oc-accent': itemAccent } },
              React.createElement('div', { className: 'oc-windowTop' },
                React.createElement('span', { className: 'oc-windowName' }, item.label),
                React.createElement('span', { className: 'oc-windowStatus' }, statusLabel),
                React.createElement('span', { className: 'oc-windowPct' }, item.percent + '%')),
              React.createElement('div', { className: 'oc-track', role: 'progressbar', 'aria-label': item.label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': item.percent },
                React.createElement('div', { className: 'oc-fill', style: { width: item.percent + '%' } })),
              React.createElement('div', { className: 'oc-reset', title: fmtReset(item.resetsAt) }, fmtRelative(item.resetsAt, now)));
          }));
        }
        panel = React.createElement('div', { className: 'oc-usagePanel' + (wide ? '' : ' oc-usagePanelCompact'), role: 'dialog', 'aria-label': 'OpenCode Go usage limits' },
          React.createElement('div', { className: 'oc-panelHeader' },
            React.createElement(OpenCodeLogo, null),
            React.createElement('div', { className: 'oc-panelHeading' },
              React.createElement('div', { className: 'oc-panelTitle' }, 'OpenCode Go'),
              React.createElement('div', { className: 'oc-panelSub' },
                React.createElement('span', { className: 'oc-statusDot', style: { background: state.ok ? 'var(--oc-green)' : 'var(--oc-red)' } }),
                state.ok ? 'Go plan · Connected' : 'Usage unavailable')),
            React.createElement('button', { type: 'button', className: 'oc-refresh' + (state.refreshing ? ' oc-spin' : ''), disabled: state.refreshing, title: 'Refresh usage', 'aria-label': 'Refresh usage', onClick: refresh }, React.createElement(RefreshIcon, null)),
            React.createElement('button', { type: 'button', className: 'oc-close', title: 'Close', 'aria-label': 'Close usage panel', onClick: function () { setOpen(false); } }, React.createElement(CloseIcon, null))),
          body,
          state.bridge ? React.createElement('div', { className: 'oc-protection', title: 'Automatic transport retries, guarded workspace edits, and vision delegation are active' },
            React.createElement('span', { className: 'oc-protectionDot' }),
            React.createElement('strong', null, 'Harness protection'),
            React.createElement('span', null, (state.bridge.resilience.retries || 0) + ' retries · vision ready')) : null,
          state.ok ? React.createElement('div', { className: 'oc-panelFooter' },
            React.createElement('span', null, state.updatedAt ? ('Updated ' + new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : 'Live usage'),
            React.createElement('a', { className: 'oc-manageLink', href: 'https://opencode.ai/workspace', target: '_blank', rel: 'noreferrer' }, 'Open dashboard ↗')) : null);
      }

      return React.createElement('div', { ref: rootRef, className: 'oc-usageRoot' }, trigger, panel);
    }

    function apply(ctx) {
      PLUGIN_CTX = ctx;
      var slots = ctx.get('slots');
      if (slots === undefined) return;

      slots.inject('conversation.input.model', function () {
        slots.register({
          name: 'conversation.input.model',
          priority: -1,
          inject: function (sessionId) {
            var models = ctx.modelDirectories;
            var sessions = ctx.sessions;
            var directory = models.directoryFor(sessionId);
            var available = sessions.subagentAddress(sessionId) === undefined;
            return {
              available: available,
              directory: directory.store,
              load: function () { if (available) directory.load().catch(function () {}); },
              select: function (selection) {
                return available ? directory.select(selection).then(function () { return true; }, function (e) { throw e; }) : Promise.resolve(false);
              }
            };
          }
        }, GroupedModelSelect);
      });

      slots.inject('sidebar.footer.action', function () {
        slots.register({ name: 'sidebar.footer.action', id: 'opencode-zen-usage', order: 0 }, UsageBadge);
      });
    }

    exports.apply = apply;
    exports.inject = ['connection', 'modelDirectories', 'sessions', 'timer'];
    return module.exports;
  }
});
