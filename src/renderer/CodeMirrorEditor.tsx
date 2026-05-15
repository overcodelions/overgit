import { useEffect, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

// Tier 1: dedicated language packages (full Lezer parsers).
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { vue } from '@codemirror/lang-vue';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

// Tier 2: legacy stream modes for the long tail. Each is a tiny tokenizer,
// not a full parser, but the highlighting is still significantly better
// than the old hljs overlay + a real caret instead of a layered fake.
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { r } from '@codemirror/legacy-modes/mode/r';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { sCSS as sassMode, less as lessMode } from '@codemirror/legacy-modes/mode/css';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';

/// Map our extension-derived language ids (see LANGUAGE_BY_EXT in
/// FileEditor) to a CodeMirror Extension. Unknown ids return [], which is
/// CM's idiomatic "no language" — the file still renders, just without
/// syntax colors.
function languageExtension(id: string | null): Extension {
  if (!id) return [];
  switch (id) {
    // Tier 1 — full parsers
    case 'typescript':
      return javascript({ typescript: true, jsx: true });
    case 'javascript':
      return javascript({ jsx: true });
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'html':
      return html();
    case 'css':
      return css();
    case 'markdown':
      return markdown();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'go':
      return go();
    case 'java':
      return java();
    case 'cpp':
    case 'c':
      return cpp();
    case 'csharp':
      return cpp(); // close enough syntactically; no dedicated CM6 C# pkg
    case 'sql':
      return sql();
    case 'xml':
      return xml();
    case 'php':
      return php();
    case 'vue':
    case 'svelte':
      return vue();
    // Tier 2 — stream modes
    case 'bash':
      return new LanguageSupport(StreamLanguage.define(shell));
    case 'powershell':
      return new LanguageSupport(StreamLanguage.define(powerShell));
    case 'ruby':
      return new LanguageSupport(StreamLanguage.define(ruby));
    case 'perl':
      return new LanguageSupport(StreamLanguage.define(perl));
    case 'lua':
      return new LanguageSupport(StreamLanguage.define(lua));
    case 'swift':
      return new LanguageSupport(StreamLanguage.define(swift));
    case 'kotlin':
    case 'scala':
    case 'groovy':
      return new LanguageSupport(StreamLanguage.define(groovy));
    case 'ini':
      return new LanguageSupport(StreamLanguage.define(properties));
    case 'toml':
      return new LanguageSupport(StreamLanguage.define(toml));
    case 'dockerfile':
      return new LanguageSupport(StreamLanguage.define(dockerFile));
    case 'cmake':
      return new LanguageSupport(StreamLanguage.define(cmake));
    case 'makefile':
      return new LanguageSupport(StreamLanguage.define(shell));
    case 'r':
      return new LanguageSupport(StreamLanguage.define(r));
    case 'erlang':
      return new LanguageSupport(StreamLanguage.define(erlang));
    case 'haskell':
      return new LanguageSupport(StreamLanguage.define(haskell));
    case 'clojure':
      return new LanguageSupport(StreamLanguage.define(clojure));
    case 'protobuf':
      return new LanguageSupport(StreamLanguage.define(protobuf));
    case 'scss':
    case 'sass':
      return new LanguageSupport(StreamLanguage.define(sassMode));
    case 'less':
      return new LanguageSupport(StreamLanguage.define(lessMode));
    default:
      return [];
  }
}

/// Highlight style tuned to overgit's palette. Pulls ink/accent from CSS
/// vars so light/dark mode flips automatically when `html.dark` toggles;
/// the literal hex values are only fallbacks until the var resolves.
const overgitHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#b587ff' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#b587ff' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: 'var(--c-ink, #f1f1f4)' },
  { tag: [t.propertyName, t.definition(t.variableName), t.definition(t.propertyName)], color: '#5b9cff' },
  { tag: [t.function(t.variableName), t.labelName], color: '#5b9cff' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#3dced7' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--c-ink, #f1f1f4)' },
  { tag: [t.typeName, t.className, t.namespace], color: '#3dced7' },
  { tag: [t.number, t.changed, t.annotation, t.modifier, t.self], color: '#f59e0b' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link], color: 'var(--c-ink-muted, #a8a8b3)' },
  { tag: [t.meta, t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--c-ink-faint, #6f6f7a)', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#5cd6dc', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: 'var(--c-accent, #8a78ff)' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#f59e0b' },
  { tag: [t.processingInstruction, t.string, t.inserted, t.special(t.string)], color: '#a3e635' },
  { tag: [t.attributeName], color: '#5b9cff' },
  { tag: [t.attributeValue], color: '#a3e635' },
  { tag: t.invalid, color: '#f87171' },
]);

/// Theme that pins font + colors to match the rest of the app. Background
/// is transparent so the wrapping pane controls the surface color.
const overgitTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '12px',
      color: 'var(--c-ink)',
      backgroundColor: 'transparent',
    },
    '.cm-scroller': {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
      lineHeight: '1.5',
    },
    '.cm-content': {
      caretColor: 'var(--c-ink)',
      padding: '8px 0',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--c-ink-faint)',
      border: 'none',
      paddingRight: '4px',
    },
    '.cm-gutterElement': {
      padding: '0 6px 0 8px',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '2.5em',
      textAlign: 'right',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.025)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--c-ink-muted)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--c-ink)',
      borderLeftWidth: '1.5px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(138, 120, 255, 0.28)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(138, 120, 255, 0.18)',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'rgba(138, 120, 255, 0.2)',
      outline: 'none',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(245, 158, 11, 0.25)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(245, 158, 11, 0.45)',
    },
    // Search / replace panel — restyled to match the `.field` + small-button
    // language used elsewhere in overgit instead of CM's default browser
    // inputs and OS-bevel buttons.
    '.cm-panels': {
      backgroundColor: 'var(--c-surface-muted)',
      color: 'var(--c-ink)',
      borderColor: 'var(--c-card-border)',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid var(--c-card-border)',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid var(--c-card-border)',
    },
    '.cm-panel.cm-search': {
      padding: '8px 10px',
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      fontSize: '12px',
    },
    '.cm-panel.cm-search label': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      color: 'var(--c-ink-muted)',
      fontSize: '11px',
      cursor: 'pointer',
      userSelect: 'none',
    },
    '.cm-panel.cm-search label input[type="checkbox"]': {
      accentColor: 'var(--c-accent)',
      margin: 0,
    },
    '.cm-panel.cm-search br': {
      display: 'none',
    },
    '.cm-textfield': {
      backgroundColor: 'var(--c-card-bg)',
      color: 'var(--c-ink)',
      border: '1px solid var(--c-card-border)',
      borderRadius: '4px',
      padding: '4px 8px',
      fontSize: '12px',
      fontFamily: 'inherit',
      outline: 'none',
      minWidth: '160px',
    },
    '.cm-textfield:focus': {
      borderColor: 'var(--c-accent)',
      boxShadow: '0 0 0 1px var(--c-accent)',
    },
    '.cm-button': {
      backgroundColor: 'var(--c-card-bg)',
      backgroundImage: 'none',
      color: 'var(--c-ink)',
      border: '1px solid var(--c-card-border)',
      borderRadius: '4px',
      padding: '3px 10px',
      fontSize: '11px',
      fontFamily: 'inherit',
      cursor: 'pointer',
    },
    '.cm-button:hover': {
      backgroundColor: 'var(--c-surface-elevated)',
    },
    '.cm-button:active': {
      backgroundColor: 'var(--c-surface-elevated)',
    },
    '.cm-panel.cm-search [name="close"]': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--c-ink-faint)',
      fontSize: '14px',
      cursor: 'pointer',
      padding: '0 4px',
    },
    '.cm-panel.cm-search [name="close"]:hover': {
      color: 'var(--c-ink)',
    },
  },
  { dark: true },
);

export function CodeMirrorEditor({
  content,
  onChange,
  language,
}: {
  content: string;
  onChange: (v: string) => void;
  language: string | null;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  // Wrap onChange in a ref so the updateListener sees the latest callback
  // without us tearing down the editor on every parent re-render that
  // hands us a new function identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mount once. Subsequent prop changes are handled by the focused effects
  // below; rebuilding the EditorView on every keystroke would discard
  // undo history, scroll position, and the caret.
  useEffect(() => {
    if (!containerRef.current) return;
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        syntaxHighlighting(overgitHighlight),
        overgitTheme,
        // `Mod-s` would normally fall through CM's keymap and let the
        // browser's "save page" prompt fire. Bind it to a no-op that
        // returns true so the keydown bubbles to the window listener
        // FileEditor wires for save. Same for `Mod-Enter` so it doesn't
        // hit defaultKeymap's insertBlankLine.
        keymap.of([
          { key: 'Mod-s', run: () => true },
          { key: 'Mod-Enter', run: () => true },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        languageCompartment.current.of(languageExtension(language)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External content sync — switching to a different file reloads
  // `content` from disk. Skip the dispatch when the doc already matches
  // to avoid clobbering the caret while the user is typing (every
  // keystroke also fires this effect because content lives in the
  // parent's state).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: content },
    });
  }, [content]);

  // Language swap — reconfigure the compartment in place so the editor
  // keeps its scroll/selection state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.current.reconfigure(languageExtension(language)),
    });
  }, [language]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
