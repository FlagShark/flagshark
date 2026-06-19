/**
 * Full-coverage AST matrix.
 *
 * Two invariants, exercised across EVERY tier-1 language × EVERY provider the
 * detectors advertise (driven from each detector's own getProviders(), so the
 * matrix grows automatically as providers are added):
 *
 *   1. PARITY  — on every advertised provider/method example, the tree-sitter
 *      (AST) engine detects exactly the same flag names as the regex engine.
 *      This is what caught the PHP `Class::method()` static-call gap.
 *   2. PRECISION — on adversarial input (a flag name sitting in a comment or a
 *      string literal), the AST engine detects strictly FEWER flags than regex.
 *      This is the entire reason AST detection exists.
 */
import { describe, it, expect } from 'vitest'

import { TypeScriptDetector } from '../../src/detection/detectors/typescript.js'
import { JavaScriptDetector } from '../../src/detection/detectors/javascript.js'
import { GoDetector } from '../../src/detection/detectors/go.js'
import { PythonDetector } from '../../src/detection/detectors/python.js'
import { JavaDetector } from '../../src/detection/detectors/java.js'
import { CSharpDetector } from '../../src/detection/detectors/csharp.js'
import { PHPDetector } from '../../src/detection/detectors/php.js'
import { RustDetector } from '../../src/detection/detectors/rust.js'
import { getImportPattern } from '../../src/detection/interface.js'

import type { FeatureFlagProvider, LanguageDetector } from '../../src/detection/interface.js'

type Make = (opts: { engine?: 'regex' | 'tree-sitter'; providers?: FeatureFlagProvider[] }) => LanguageDetector

const TIER1: { lang: string; ext: string; make: Make }[] = [
  { lang: 'typescript', ext: 'ts', make: (o) => new TypeScriptDetector(o) },
  { lang: 'javascript', ext: 'js', make: (o) => new JavaScriptDetector(o) },
  { lang: 'go', ext: 'go', make: (o) => new GoDetector(o) },
  { lang: 'python', ext: 'py', make: (o) => new PythonDetector(o) },
  { lang: 'java', ext: 'java', make: (o) => new JavaDetector(o) },
  { lang: 'csharp', ext: 'cs', make: (o) => new CSharpDetector(o) },
  { lang: 'php', ext: 'php', make: (o) => new PHPDetector(o) },
  { lang: 'rust', ext: 'rs', make: (o) => new RustDetector(o) },
]

/** Wrap a bare call example in a minimal, parseable scaffold for the language. */
function wrap(lang: string, ex: string): string {
  switch (lang) {
    case 'go':
      return `package main\nfunc _f() {\n${ex}\n}`
    case 'java':
      return `class _F { void _m() {\n${ex};\n} }`
    case 'csharp':
      return `class _F { void _M() {\n${ex};\n} }`
    case 'php':
      return `<?php\n${ex};`
    case 'rust':
      return `fn _f() { let _ =\n${ex};\n}`
    default:
      return ex // ts / js / python — bare expression statement parses
  }
}

/** A comment line carrying the import pattern so the import gate passes. */
function gateLine(lang: string, pattern: string): string {
  const c = lang === 'python' ? '#' : '//'
  return `${c} import ${pattern}\n`
}

const names = (flags: { name: string }[]) => flags.map((f) => f.name).sort()

// ────────────────────────────────────────────────────────────────────────────
// 1. PARITY — every advertised provider/method example, AST === regex
// ────────────────────────────────────────────────────────────────────────────

for (const { lang, ext, make } of TIER1) {
  const providers = make({}).getProviders()

  describe(`AST↔regex parity / ${lang} (${providers.length} providers)`, () => {
    for (const provider of providers) {
      const positional = provider.methods.filter((m) => m.flagKeyIndex >= 0 && (m.examples?.length ?? 0) > 0)
      if (positional.length === 0) continue

      it(`${provider.name}`, async () => {
        const pattern = getImportPattern(provider)
        for (const method of positional) {
          for (const example of method.examples!) {
            const content = (pattern ? gateLine(lang, pattern) : '') + wrap(lang, example)
            const ts = names(await make({ engine: 'tree-sitter' }).detectFlags(`f.${ext}`, content))
            const rx = names(await make({ engine: 'regex' }).detectFlags(`f.${ext}`, content))
            expect(ts, `${provider.name} · ${method.name} · "${example}"`).toEqual(rx)
          }
        }
      })
    }
  })
}

// ────────────────────────────────────────────────────────────────────────────
// 2. PRECISION — AST ignores flag names in comments + strings; regex doesn't
// ────────────────────────────────────────────────────────────────────────────

const PRECISION: { lang: string; ext: string; make: Make; real: string; code: string }[] = [
  {
    lang: 'typescript',
    ext: 'ts',
    make: (o) => new TypeScriptDetector(o),
    real: 'real-ts',
    code: [
      `import * as LD from 'launchdarkly-node-server-sdk'`,
      `const c = LD.init('k')`,
      `// c.variation('comment-ts', user, false)`,
      `c.variation('real-ts', user, false)`,
      `const s = "c.variation('string-ts', user, false)"`,
    ].join('\n'),
  },
  {
    lang: 'go',
    ext: 'go',
    make: (o) => new GoDetector(o),
    real: 'real-go',
    code: [
      `package main`,
      `import ld "github.com/launchdarkly/go-server-sdk/v7"`,
      `func f() {`,
      `  // client.BoolVariation("comment-go", ctx, false)`,
      `  client.BoolVariation("real-go", ctx, false)`,
      `  s := "client.BoolVariation(\\"string-go\\", ctx, false)"`,
      `  _ = s`,
      `}`,
    ].join('\n'),
  },
  {
    lang: 'python',
    ext: 'py',
    make: (o) => new PythonDetector(o),
    real: 'real-py',
    code: [
      `import ldclient`,
      `client = ldclient.get()`,
      `# client.variation("comment-py", user, False)`,
      `client.variation("real-py", user, False)`,
      `s = 'client.variation("string-py", user, False)'`,
    ].join('\n'),
  },
  {
    lang: 'java',
    ext: 'java',
    make: (o) => new JavaDetector(o),
    real: 'real-java',
    code: [
      `import com.launchdarkly.sdk.server.LDClient;`,
      `class A { void m(LDClient client) {`,
      `  // client.boolVariation("comment-java", ctx, false)`,
      `  client.boolVariation("real-java", ctx, false);`,
      `  String s = "client.boolVariation(\\"string-java\\", ctx, false)";`,
      `} }`,
    ].join('\n'),
  },
  {
    lang: 'csharp',
    ext: 'cs',
    make: (o) => new CSharpDetector(o),
    real: 'real-cs',
    code: [
      `using LaunchDarkly.Sdk.Server;`,
      `class A { void M(LdClient client) {`,
      `  // client.BoolVariation("comment-cs", ctx, false)`,
      `  client.BoolVariation("real-cs", ctx, false);`,
      `  string s = "client.BoolVariation(\\"string-cs\\", ctx, false)";`,
      `} }`,
    ].join('\n'),
  },
  {
    lang: 'php',
    ext: 'php',
    make: (o) => new PHPDetector(o),
    real: 'real-php',
    code: [
      `<?php`,
      `use LaunchDarkly\\LDClient;`,
      `// $client->variation("comment-php", $u, false)`,
      `$client->variation("real-php", $u, false);`,
      `$s = '$client->variation("string-php", $u, false)';`,
    ].join('\n'),
  },
  {
    lang: 'rust',
    ext: 'rs',
    make: (o) => new RustDetector(o),
    real: 'real-rust',
    code: [
      `use launchdarkly_server_sdk::Client;`,
      `fn f(client: &Client, ctx: &Context) {`,
      `  // client.bool_variation(&ctx, "comment-rust", false)`,
      `  let _ = client.bool_variation(&ctx, "real-rust", false);`,
      `  let s = "client.bool_variation(&ctx, \\"string-rust\\", false)";`,
      `}`,
    ].join('\n'),
  },
]

describe('AST precision — comments and strings are not flags', () => {
  for (const { lang, ext, make, real, code } of PRECISION) {
    it(`${lang}: AST detects the real call only; regex over-detects`, async () => {
      const ts = names(await make({ engine: 'tree-sitter' }).detectFlags(`f.${ext}`, code))
      const rx = names(await make({ engine: 'regex' }).detectFlags(`f.${ext}`, code))

      // AST finds the real flag and nothing from the comment or string.
      expect(ts).toContain(real)
      expect(ts.filter((n) => n.startsWith('comment-') || n.startsWith('string-'))).toEqual([])

      // Regex false-positives on at least one of the decoys — the whole point.
      expect(rx.length).toBeGreaterThan(ts.length)
    })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// 3. DECOY ROBUSTNESS — flag-shaped text in trickier constructs is ignored
//    (block comments, template/interpolated strings, triple-quotes, verbatim
//     strings, heredocs). Each case has a REAL call that must be detected and
//     a "decoy" flag inside the construct that must NOT be.
// ────────────────────────────────────────────────────────────────────────────

const DECOYS: { name: string; ext: string; make: Make; code: string }[] = [
  {
    name: 'typescript / block comment',
    ext: 'ts',
    make: (o) => new TypeScriptDetector(o),
    code: `import 'launchdarkly-node-server-sdk'\nclient.variation('real', u, false)\n/* client.variation('decoy', u, false) */`,
  },
  {
    name: 'typescript / template string',
    ext: 'ts',
    make: (o) => new TypeScriptDetector(o),
    code: `import 'launchdarkly-node-server-sdk'\nclient.variation('real', u, false)\nconst s = \`client.variation('decoy', u, false)\``,
  },
  {
    name: 'python / triple-quoted string',
    ext: 'py',
    make: (o) => new PythonDetector(o),
    code: `import ldclient\nclient.variation("real", u, False)\ndoc = """client.variation("decoy", u, False)"""`,
  },
  {
    name: 'go / block comment',
    ext: 'go',
    make: (o) => new GoDetector(o),
    code: `package m\nimport ld "github.com/launchdarkly/go-server-sdk/v7"\nfunc f(){ client.BoolVariation("real", c, false)\n/* client.BoolVariation("decoy", c, false) */ }`,
  },
  {
    name: 'java / block comment',
    ext: 'java',
    make: (o) => new JavaDetector(o),
    code: `import com.launchdarkly.sdk.server.LDClient;\nclass A { void m(LDClient client){ client.boolVariation("real", c, false);\n/* client.boolVariation("decoy", c, false); */ } }`,
  },
  {
    name: 'csharp / verbatim string',
    ext: 'cs',
    make: (o) => new CSharpDetector(o),
    code: `using LaunchDarkly.Sdk.Server;\nclass A { void M(LdClient client){ client.BoolVariation("real", c, false);\nstring s = @"client.BoolVariation(""decoy"", c, false)"; } }`,
  },
  {
    name: 'php / heredoc',
    ext: 'php',
    make: (o) => new PHPDetector(o),
    code: `<?php\nuse LaunchDarkly\\LDClient;\n$client->variation("real", $u, false);\n$s = <<<EOT\n\$client->variation("decoy", $u, false)\nEOT;`,
  },
  {
    name: 'rust / block comment',
    ext: 'rs',
    make: (o) => new RustDetector(o),
    code: `use launchdarkly_server_sdk::Client;\nfn f(c: &Client, x: &Context){ let _ = c.bool_variation(&x, "real", false);\n/* c.bool_variation(&x, "decoy", false) */ }`,
  },
]

describe('AST decoy robustness — comments/strings beyond the simple cases', () => {
  for (const { name, ext, make, code } of DECOYS) {
    it(name, async () => {
      const ts = names(await make({ engine: 'tree-sitter' }).detectFlags(`f.${ext}`, code))
      expect(ts).toContain('real')
      expect(ts).not.toContain('decoy')
    })
  }
})
