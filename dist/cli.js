#!/usr/bin/env node

// src/cli.ts
import { execFileSync as execFileSync2 } from "child_process";
import * as fs from "fs";
import * as path from "path";

// src/detection/interface.ts
var Languages = {
  Go: "go",
  TypeScript: "typescript",
  JavaScript: "javascript",
  Python: "python",
  Java: "java",
  Kotlin: "kotlin",
  Swift: "swift",
  Ruby: "ruby",
  CSharp: "csharp",
  PHP: "php",
  Rust: "rust",
  CPP: "cpp",
  ObjectiveC: "objc"
};
function getImportPattern(provider) {
  return provider.importPattern || provider.packagePath || "";
}

// src/detection/helpers.ts
function deduplicateFlags(flags) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const flag of flags) {
    const key = `${flag.filePath}:${flag.name}:${flag.lineNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(flag);
    }
  }
  return result;
}
function extractStringArgument(callText, paramIndex) {
  const parenStart = callText.indexOf("(");
  if (parenStart === -1) {
    return null;
  }
  const parenEnd = callText.lastIndexOf(")");
  if (parenEnd === -1) {
    return null;
  }
  const argsStr = callText.slice(parenStart + 1, parenEnd);
  const args = splitArguments(argsStr);
  if (paramIndex < 0 || paramIndex >= args.length) {
    return null;
  }
  const arg = args[paramIndex].trim();
  const match = arg.match(/^["'`](.*)["'`]$/);
  return match ? match[1] : null;
}
function splitArguments(argsStr) {
  const args = [];
  let depth = 0;
  let current = "";
  let inString = null;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    const prev = i > 0 ? argsStr[i - 1] : "";
    if (inString) {
      current += ch;
      if (ch === inString && prev !== "\\") {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    args.push(current);
  }
  return args;
}
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function detectFlagsWithRegex(filename, content, language, providers) {
  const flags = [];
  const lines = content.split("\n");
  for (const provider of providers) {
    if (!provider.enabled) {
      continue;
    }
    if (provider.methods.length === 0) {
      continue;
    }
    const providerName = provider.name;
    const importPat = getImportPattern(provider);
    if (importPat) {
      const hasImport = content.includes(importPat) || lines.some((line) => line.includes(importPat));
      if (!hasImport) {
        continue;
      }
    }
    for (const method of provider.methods) {
      if (method.flagKeyIndex < 0) {
        continue;
      }
      const pattern = buildSingleMethodPattern(method.name);
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const callStart = match.index;
          const restOfContent = getCallExpression(lines, lineIdx, callStart);
          if (!restOfContent) {
            continue;
          }
          const flagKey = extractStringArgument(restOfContent, method.flagKeyIndex);
          if (flagKey && isValidFlagKey(flagKey)) {
            flags.push({
              name: flagKey,
              filePath: filename,
              lineNumber: lineIdx + 1,
              language,
              provider: importPat || providerName
            });
          }
        }
      }
    }
  }
  return deduplicateFlags(flags);
}
function buildSingleMethodPattern(methodName) {
  const escaped = escapeRegExp(methodName);
  return new RegExp(`(?:^|[^\\w])(?:\\w+[.:])?${escaped}\\s*\\(`, "g");
}
function getCallExpression(lines, startLine, startCol) {
  let result = lines[startLine].slice(startCol);
  let depth = 0;
  let foundOpen = false;
  for (let i = 0; i < result.length; i++) {
    if (result[i] === "(") {
      depth++;
      foundOpen = true;
    } else if (result[i] === ")") {
      depth--;
      if (foundOpen && depth === 0) {
        return result.slice(0, i + 1);
      }
    }
  }
  const maxLines = Math.min(startLine + 10, lines.length);
  for (let lineIdx = startLine + 1; lineIdx < maxLines; lineIdx++) {
    const line = lines[lineIdx];
    result += "\n" + line;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "(") {
        depth++;
        foundOpen = true;
      } else if (line[i] === ")") {
        depth--;
        if (foundOpen && depth === 0) {
          return result;
        }
      }
    }
  }
  return foundOpen ? result : null;
}
function isValidFlagKey(key) {
  if (key.length === 0 || key.length > 256) {
    return false;
  }
  const invalidPrefixes = ["http://", "https://", "file://", "/"];
  for (const prefix of invalidPrefixes) {
    if (key.startsWith(prefix)) {
      return false;
    }
  }
  return true;
}

// src/detection/detectors/cpp.ts
var CPPDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultCPPProviders();
  }
  language() {
    return Languages.CPP;
  }
  fileExtensions() {
    return [".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".h", ".c"];
  }
  supportsFile(filename) {
    const ext = filename.toLowerCase().split(".").pop();
    return ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++", "h", "c"].includes(ext ?? "");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultCPPProviders() {
  return [
    {
      name: "LaunchDarkly C++ SDK",
      importPattern: "launchdarkly",
      description: "LaunchDarkly C/C++ Server SDK",
      enabled: true,
      methods: [
        {
          name: "BoolVariation",
          flagKeyIndex: 1,
          examples: ['client->BoolVariation(context, "flag-key", false)']
        },
        {
          name: "StringVariation",
          flagKeyIndex: 1,
          examples: ['client->StringVariation(context, "flag-key", "default")']
        },
        {
          name: "IntVariation",
          flagKeyIndex: 1,
          examples: ['client->IntVariation(context, "flag-key", 0)']
        },
        {
          name: "DoubleVariation",
          flagKeyIndex: 1,
          examples: ['client->DoubleVariation(context, "flag-key", 0.0)']
        }
      ]
    },
    {
      name: "Unleash C++ SDK",
      importPattern: "unleash",
      description: "Unleash C++ Client SDK",
      enabled: true,
      methods: [
        { name: "isEnabled", flagKeyIndex: 0, examples: ['client->isEnabled("feature-toggle")'] },
        { name: "getVariant", flagKeyIndex: 0, examples: ['client->getVariant("feature-toggle")'] }
      ]
    },
    {
      name: "ConfigCat C++ SDK",
      importPattern: "configcat",
      description: "ConfigCat C++ SDK",
      enabled: true,
      methods: [
        { name: "getValue", flagKeyIndex: 0, examples: ['client->getValue("flag-key", false)'] }
      ]
    },
    {
      name: "GrowthBook C++ SDK",
      importPattern: "growthbook",
      description: "GrowthBook C++ SDK",
      enabled: true,
      methods: [
        { name: "isOn", flagKeyIndex: 0, examples: ['gb->isOn("feature-key")'] },
        {
          name: "getFeatureValue",
          flagKeyIndex: 0,
          examples: ['gb->getFeatureValue("feature-key", fallbackValue)']
        }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom C/C++ feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")']
        },
        {
          name: "is_feature_enabled",
          flagKeyIndex: 0,
          examples: ['is_feature_enabled("feature-name")']
        },
        { name: "checkFeature", flagKeyIndex: 0, examples: ['checkFeature("feature-name")'] },
        { name: "hasFeature", flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/csharp.ts
var CSharpDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultCSharpProviders();
  }
  language() {
    return Languages.CSharp;
  }
  fileExtensions() {
    return [".cs", ".csx"];
  }
  supportsFile(filename) {
    const lower = filename.toLowerCase();
    return lower.endsWith(".cs") || lower.endsWith(".csx");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultCSharpProviders() {
  return [
    {
      name: "LaunchDarkly .NET SDK",
      importPattern: "LaunchDarkly.Sdk",
      description: "LaunchDarkly .NET SDK",
      enabled: true,
      methods: [
        {
          name: "BoolVariation",
          flagKeyIndex: 0,
          examples: ['client.BoolVariation("flag-key", context, false)']
        },
        {
          name: "StringVariation",
          flagKeyIndex: 0,
          examples: ['client.StringVariation("flag-key", context, "default")']
        },
        {
          name: "IntVariation",
          flagKeyIndex: 0,
          examples: ['client.IntVariation("flag-key", context, 0)']
        },
        {
          name: "DoubleVariation",
          flagKeyIndex: 0,
          examples: ['client.DoubleVariation("flag-key", context, 0.0)']
        }
      ]
    },
    {
      name: "Unleash .NET SDK",
      importPattern: "Unleash",
      description: "Unleash .NET SDK",
      enabled: true,
      methods: [
        { name: "IsEnabled", flagKeyIndex: 0, examples: ['unleash.IsEnabled("feature-toggle")'] },
        { name: "GetVariant", flagKeyIndex: 0, examples: ['unleash.GetVariant("feature-toggle")'] }
      ]
    },
    {
      name: "Split.io .NET SDK",
      importPattern: "Splitio.Services.Client",
      description: "Split.io .NET SDK",
      enabled: true,
      methods: [
        {
          name: "GetTreatment",
          flagKeyIndex: 1,
          examples: ['client.GetTreatment(key, "split-name")']
        },
        {
          name: "GetTreatments",
          flagKeyIndex: 1,
          examples: ['client.GetTreatments(key, new List<string>{"split1", "split2"})']
        }
      ]
    },
    {
      name: "Optimizely .NET SDK",
      importPattern: "OptimizelySDK",
      description: "Optimizely Feature Experimentation .NET SDK",
      enabled: true,
      methods: [
        { name: "Decide", flagKeyIndex: 0, examples: ['user.Decide("flag-key", options)'] },
        {
          name: "IsFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['optimizely.IsFeatureEnabled("feature-key", userId)']
        }
      ]
    },
    {
      name: "Flagsmith .NET SDK",
      importPattern: "Flagsmith",
      description: "Flagsmith .NET SDK",
      enabled: true,
      methods: [
        {
          name: "HasFeatureFlag",
          flagKeyIndex: 0,
          examples: ['flags.HasFeatureFlag("feature-name")']
        },
        {
          name: "GetFeatureValue",
          flagKeyIndex: 0,
          examples: ['flags.GetFeatureValue("feature-name")']
        }
      ]
    },
    {
      name: "ConfigCat .NET SDK",
      importPattern: "ConfigCat.Client",
      description: "ConfigCat .NET SDK",
      enabled: true,
      methods: [
        { name: "GetValue", flagKeyIndex: 0, examples: ['client.GetValue("flag-key", false)'] },
        {
          name: "GetValueAsync",
          flagKeyIndex: 0,
          examples: ['await client.GetValueAsync("flag-key", false)']
        }
      ]
    },
    {
      name: "Statsig .NET SDK",
      importPattern: "Statsig",
      description: "Statsig .NET SDK",
      enabled: true,
      methods: [
        {
          name: "CheckGate",
          flagKeyIndex: 1,
          examples: ['StatsigServer.CheckGate(user, "gate-name")']
        },
        {
          name: "GetExperiment",
          flagKeyIndex: 1,
          examples: ['StatsigServer.GetExperiment(user, "experiment-name")']
        },
        {
          name: "GetConfig",
          flagKeyIndex: 1,
          examples: ['StatsigServer.GetConfig(user, "config-name")']
        }
      ]
    },
    {
      name: "GrowthBook .NET SDK",
      importPattern: "GrowthBook",
      description: "GrowthBook .NET SDK",
      enabled: true,
      methods: [
        { name: "IsOn", flagKeyIndex: 0, examples: ['gb.IsOn("feature-key")'] },
        {
          name: "GetFeatureValue",
          flagKeyIndex: 0,
          examples: ['gb.GetFeatureValue<string>("feature-key", fallbackValue)']
        }
      ]
    },
    {
      name: "DevCycle .NET SDK",
      importPattern: "DevCycle.SDK.Server",
      description: "DevCycle .NET SDK",
      enabled: true,
      methods: [
        {
          name: "VariableValue",
          flagKeyIndex: 1,
          examples: ['client.VariableValue(user, "variable-key", defaultValue)']
        },
        {
          name: "Variable",
          flagKeyIndex: 1,
          examples: ['client.Variable(user, "variable-key", defaultValue)']
        }
      ]
    },
    {
      name: "Eppo .NET SDK",
      importPattern: "Eppo",
      description: "Eppo .NET SDK",
      enabled: true,
      methods: [
        {
          name: "GetBooleanAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.GetBooleanAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "GetStringAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.GetStringAssignment("flag-key", subjectKey, defaultValue)']
        }
      ]
    },
    {
      name: "PostHog .NET SDK",
      importPattern: "PostHog",
      description: "PostHog .NET SDK",
      enabled: true,
      methods: [
        {
          name: "IsFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['posthog.IsFeatureEnabled("flag-key", distinctId)']
        },
        {
          name: "GetFeatureFlag",
          flagKeyIndex: 0,
          examples: ['posthog.GetFeatureFlag("flag-key", distinctId)']
        }
      ]
    },
    {
      name: "Microsoft Feature Management",
      importPattern: "Microsoft.FeatureManagement",
      description: "Microsoft Feature Management for .NET",
      enabled: true,
      methods: [
        {
          name: "IsEnabledAsync",
          flagKeyIndex: 0,
          examples: ['await featureManager.IsEnabledAsync("feature-name")']
        },
        {
          name: "IsEnabled",
          flagKeyIndex: 0,
          examples: ['featureManager.IsEnabled("feature-name")']
        }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom C# feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "IsFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['IsFeatureEnabled("feature-name")']
        },
        { name: "CheckFeature", flagKeyIndex: 0, examples: ['CheckFeature("feature-name")'] },
        { name: "HasFeature", flagKeyIndex: 0, examples: ['HasFeature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/go.ts
var GoDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultGoProviders();
  }
  language() {
    return Languages.Go;
  }
  fileExtensions() {
    return [".go"];
  }
  supportsFile(filename) {
    return filename.toLowerCase().endsWith(".go");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultGoProviders() {
  return [
    {
      name: "LaunchDarkly Go SDK",
      packagePath: "github.com/launchdarkly/go-server-sdk/v7",
      description: "LaunchDarkly feature flag service",
      enabled: true,
      methods: [
        {
          name: "BoolVariation",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.BoolVariation("flag-key", context, false)']
        },
        {
          name: "StringVariation",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.StringVariation("flag-key", context, "default")']
        },
        {
          name: "IntVariation",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.IntVariation("flag-key", context, 0)']
        },
        {
          name: "Float64Variation",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.Float64Variation("flag-key", context, 0.0)']
        },
        {
          name: "JSONVariation",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.JSONVariation("flag-key", context, ldvalue.Null())']
        },
        {
          name: "BoolVariationDetail",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.BoolVariationDetail("flag-key", context, false)']
        },
        {
          name: "StringVariationDetail",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.StringVariationDetail("flag-key", context, "default")']
        },
        {
          name: "IntVariationDetail",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.IntVariationDetail("flag-key", context, 0)']
        },
        {
          name: "Float64VariationDetail",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.Float64VariationDetail("flag-key", context, 0.0)']
        },
        {
          name: "JSONVariationDetail",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.JSONVariationDetail("flag-key", context, ldvalue.Null())']
        }
      ]
    },
    {
      name: "ZeroFlag",
      packagePath: "github.com/aviva-zero/zeroflag",
      description: "Custom ZeroFlag implementation",
      enabled: true,
      methods: [
        {
          name: "Bool",
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['zeroflag.Bool(ctx, "feature-flag")']
        }
      ]
    },
    {
      name: "Unleash",
      packagePath: "github.com/Unleash/unleash-client-go/v4",
      description: "Unleash feature toggle service",
      enabled: true,
      methods: [
        { name: "IsEnabled", flagKeyIndex: 0, examples: ['unleash.IsEnabled("feature-toggle")'] },
        { name: "GetVariant", flagKeyIndex: 0, examples: ['unleash.GetVariant("feature-toggle")'] }
      ]
    },
    {
      name: "Flipt",
      packagePath: "go.flipt.io/flipt/sdk/go",
      description: "Flipt open-source feature flag solution",
      enabled: true,
      methods: [
        {
          name: "Boolean",
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['flipt.Boolean(ctx, "flag-key", "entity-id", context)']
        }
      ]
    },
    {
      name: "Split.io",
      packagePath: "github.com/splitio/go-client/v6/splitio/client",
      description: "Split.io feature flag and experimentation platform",
      enabled: true,
      methods: [
        {
          name: "Treatment",
          flagKeyIndex: 1,
          examples: ['client.Treatment("user-key", "split-name", nil)']
        }
      ]
    },
    {
      name: "Optimizely Go SDK",
      packagePath: "github.com/optimizely/go-sdk/v2",
      description: "Optimizely Feature Experimentation Go SDK",
      enabled: true,
      methods: [
        {
          name: "Decide",
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['user.Decide("flag-key", options)']
        }
      ]
    },
    {
      name: "Flagsmith Go SDK",
      packagePath: "github.com/Flagsmith/flagsmith-go-client/v2",
      description: "Flagsmith Go SDK",
      enabled: true,
      methods: [
        {
          name: "GetIdentityFlags",
          flagKeyIndex: 0,
          examples: ['client.GetIdentityFlags(ctx, "identifier", traits)']
        },
        {
          name: "IsFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['flags.IsFeatureEnabled("feature-name")']
        }
      ]
    },
    {
      name: "ConfigCat Go SDK",
      packagePath: "github.com/configcat/go-sdk/v7",
      description: "ConfigCat Go SDK",
      enabled: true,
      methods: [
        {
          name: "GetBoolValue",
          flagKeyIndex: 0,
          examples: ['client.GetBoolValue("flag-key", false, user)']
        },
        {
          name: "GetStringValue",
          flagKeyIndex: 0,
          examples: ['client.GetStringValue("flag-key", "default", user)']
        },
        {
          name: "GetIntValue",
          flagKeyIndex: 0,
          examples: ['client.GetIntValue("flag-key", 0, user)']
        }
      ]
    },
    {
      name: "Statsig Go SDK",
      packagePath: "github.com/statsig-io/go-sdk",
      description: "Statsig Go SDK",
      enabled: true,
      methods: [
        {
          name: "CheckGate",
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['statsig.CheckGate(user, "gate-name")']
        },
        {
          name: "GetExperiment",
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['statsig.GetExperiment(user, "experiment-name")']
        },
        {
          name: "GetConfig",
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['statsig.GetConfig(user, "config-name")']
        }
      ]
    },
    {
      name: "GrowthBook Go SDK",
      packagePath: "github.com/growthbook/growthbook-golang",
      description: "GrowthBook Go SDK",
      enabled: true,
      methods: [
        { name: "Feature", flagKeyIndex: 0, examples: ['gb.Feature("feature-key")'] },
        { name: "EvalFeature", flagKeyIndex: 0, examples: ['gb.EvalFeature("feature-key")'] }
      ]
    },
    {
      name: "DevCycle Go SDK",
      packagePath: "github.com/devcyclehq/go-server-sdk",
      description: "DevCycle Go SDK",
      enabled: true,
      methods: [
        {
          name: "Variable",
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['client.Variable(user, "variable-key", defaultValue)']
        },
        {
          name: "VariableValue",
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['client.VariableValue(user, "variable-key", defaultValue)']
        }
      ]
    },
    {
      name: "Eppo Go SDK",
      packagePath: "github.com/Eppo-exp/golang-sdk",
      description: "Eppo Go SDK",
      enabled: true,
      methods: [
        {
          name: "GetBoolAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.GetBoolAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "GetStringAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.GetStringAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "GetNumericAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.GetNumericAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "GetJSONAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.GetJSONAssignment("flag-key", subjectKey, defaultValue)']
        }
      ]
    },
    {
      name: "PostHog Go SDK",
      packagePath: "github.com/posthog/posthog-go",
      description: "PostHog Go SDK",
      enabled: true,
      methods: [
        {
          name: "IsFeatureEnabled",
          flagKeyIndex: 0,
          examples: [
            'client.IsFeatureEnabled(posthog.FeatureFlagPayload{Key: "flag-key", DistinctId: distinctId})'
          ]
        },
        {
          name: "GetFeatureFlag",
          flagKeyIndex: 0,
          examples: [
            'client.GetFeatureFlag(posthog.FeatureFlagPayload{Key: "flag-key", DistinctId: distinctId})'
          ]
        },
        {
          name: "GetFeatureFlagPayload",
          flagKeyIndex: 0,
          examples: [
            'client.GetFeatureFlagPayload(posthog.FeatureFlagPayload{Key: "flag-key", DistinctId: distinctId})'
          ]
        }
      ]
    }
  ];
}

// src/detection/detectors/java.ts
var JavaDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultJavaProviders();
  }
  language() {
    return Languages.Java;
  }
  fileExtensions() {
    return [".java"];
  }
  supportsFile(filename) {
    return filename.toLowerCase().endsWith(".java");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultJavaProviders() {
  return [
    {
      name: "LaunchDarkly Java SDK",
      importPattern: "com.launchdarkly.sdk",
      description: "LaunchDarkly Java SDK",
      enabled: true,
      methods: [
        {
          name: "boolVariation",
          flagKeyIndex: 0,
          examples: ['client.boolVariation("flag-key", context, false)']
        },
        {
          name: "stringVariation",
          flagKeyIndex: 0,
          examples: ['client.stringVariation("flag-key", context, "default")']
        },
        {
          name: "intVariation",
          flagKeyIndex: 0,
          examples: ['client.intVariation("flag-key", context, 0)']
        },
        {
          name: "doubleVariation",
          flagKeyIndex: 0,
          examples: ['client.doubleVariation("flag-key", context, 0.0)']
        }
      ]
    },
    {
      name: "Unleash Java SDK",
      importPattern: "io.getunleash",
      description: "Unleash Java SDK",
      enabled: true,
      methods: [
        { name: "isEnabled", flagKeyIndex: 0, examples: ['unleash.isEnabled("feature-toggle")'] },
        { name: "getVariant", flagKeyIndex: 0, examples: ['unleash.getVariant("feature-toggle")'] }
      ]
    },
    {
      name: "Split.io Java SDK",
      importPattern: "io.split.client",
      description: "Split.io Java SDK",
      enabled: true,
      methods: [
        {
          name: "getTreatment",
          flagKeyIndex: 1,
          examples: ['client.getTreatment(key, "split-name")']
        },
        {
          name: "getTreatments",
          flagKeyIndex: 1,
          examples: ['client.getTreatments(key, Arrays.asList("split1", "split2"))']
        }
      ]
    },
    {
      name: "Flipt Java SDK",
      importPattern: "io.flipt",
      description: "Flipt Java SDK",
      enabled: true,
      methods: [
        {
          name: "evaluateBoolean",
          flagKeyIndex: 0,
          examples: ['flipt.evaluateBoolean("flag-key", entityId, context)']
        },
        {
          name: "evaluateVariant",
          flagKeyIndex: 0,
          examples: ['flipt.evaluateVariant("flag-key", entityId, context)']
        }
      ]
    },
    {
      name: "Optimizely Java SDK",
      importPattern: "com.optimizely.ab",
      description: "Optimizely Feature Experimentation Java SDK",
      enabled: true,
      methods: [
        { name: "decide", flagKeyIndex: 0, examples: ['user.decide("flag-key", options)'] },
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['optimizely.isFeatureEnabled("feature-key", userId)']
        }
      ]
    },
    {
      name: "Flagsmith Java SDK",
      importPattern: "com.flagsmith",
      description: "Flagsmith Java SDK",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['flags.isFeatureEnabled("feature-name")']
        },
        {
          name: "getFeatureValue",
          flagKeyIndex: 0,
          examples: ['flags.getFeatureValue("feature-name")']
        }
      ]
    },
    {
      name: "ConfigCat Java SDK",
      importPattern: "com.configcat",
      description: "ConfigCat Java SDK",
      enabled: true,
      methods: [
        {
          name: "getValue",
          flagKeyIndex: 1,
          examples: ['client.getValue(Boolean.class, "flag-key", false)']
        },
        {
          name: "getValueDetails",
          flagKeyIndex: 1,
          examples: ['client.getValueDetails(Boolean.class, "flag-key", false)']
        }
      ]
    },
    {
      name: "Statsig Java SDK",
      importPattern: "com.statsig",
      description: "Statsig Java SDK",
      enabled: true,
      methods: [
        { name: "checkGate", flagKeyIndex: 1, examples: ['statsig.checkGate(user, "gate-name")'] },
        {
          name: "getExperiment",
          flagKeyIndex: 1,
          examples: ['statsig.getExperiment(user, "experiment-name")']
        },
        {
          name: "getConfig",
          flagKeyIndex: 1,
          examples: ['statsig.getConfig(user, "config-name")']
        }
      ]
    },
    {
      name: "GrowthBook Java SDK",
      importPattern: "growthbook.sdk",
      description: "GrowthBook Java SDK",
      enabled: true,
      methods: [
        { name: "isOn", flagKeyIndex: 0, examples: ['gb.isOn("feature-key")'] },
        {
          name: "getFeatureValue",
          flagKeyIndex: 0,
          examples: ['gb.getFeatureValue("feature-key", defaultValue)']
        },
        { name: "evalFeature", flagKeyIndex: 0, examples: ['gb.evalFeature("feature-key")'] }
      ]
    },
    {
      name: "DevCycle Java SDK",
      importPattern: "com.devcycle",
      description: "DevCycle Java SDK",
      enabled: true,
      methods: [
        {
          name: "variableValue",
          flagKeyIndex: 1,
          examples: ['client.variableValue(user, "variable-key", defaultValue)']
        },
        { name: "variable", flagKeyIndex: 1, examples: ['client.variable(user, "variable-key")'] }
      ]
    },
    {
      name: "Eppo Java SDK",
      importPattern: "com.eppo",
      description: "Eppo Java SDK",
      enabled: true,
      methods: [
        {
          name: "getBooleanAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getBooleanAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "getStringAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getStringAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "getJSONAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getJSONAssignment("flag-key", subjectKey, defaultValue)']
        }
      ]
    },
    {
      name: "PostHog Java SDK",
      importPattern: "com.posthog.java",
      description: "PostHog Java SDK",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['posthog.isFeatureEnabled("flag-key", distinctId)']
        },
        {
          name: "getFeatureFlag",
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlag("flag-key", distinctId)']
        },
        {
          name: "getFeatureFlagPayload",
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlagPayload("flag-key", distinctId)']
        }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom Java feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")']
        },
        { name: "checkFeature", flagKeyIndex: 0, examples: ['checkFeature("feature-name")'] },
        { name: "hasFeature", flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/typescript.ts
var TypeScriptDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultTypeScriptProviders();
  }
  language() {
    return Languages.TypeScript;
  }
  fileExtensions() {
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  }
  supportsFile(filename) {
    const ext = filename.toLowerCase().split(".").pop();
    return ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext ?? "");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultTypeScriptProviders() {
  return [
    {
      name: "LaunchDarkly JavaScript SDK",
      importPattern: "@launchdarkly/js-client-sdk",
      description: "LaunchDarkly JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        {
          name: "variation",
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", defaultValue)']
        },
        {
          name: "boolVariation",
          flagKeyIndex: 0,
          examples: ['client.boolVariation("flag-key", false)']
        }
      ]
    },
    {
      name: "LaunchDarkly Node Server SDK",
      importPattern: "@launchdarkly/node-server-sdk",
      description: "LaunchDarkly Node.js Server SDK",
      enabled: true,
      methods: [
        {
          name: "variation",
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", context, defaultValue)']
        },
        {
          name: "boolVariation",
          flagKeyIndex: 0,
          examples: ['client.boolVariation("flag-key", context, false)']
        },
        {
          name: "stringVariation",
          flagKeyIndex: 0,
          examples: ['client.stringVariation("flag-key", context, "default")']
        },
        {
          name: "intVariation",
          flagKeyIndex: 0,
          examples: ['client.intVariation("flag-key", context, 0)']
        },
        {
          name: "doubleVariation",
          flagKeyIndex: 0,
          examples: ['client.doubleVariation("flag-key", context, 0.0)']
        },
        {
          name: "jsonVariation",
          flagKeyIndex: 0,
          examples: ['client.jsonVariation("flag-key", context, {})']
        },
        {
          name: "variationDetail",
          flagKeyIndex: 0,
          examples: ['client.variationDetail("flag-key", context, defaultValue)']
        }
      ]
    },
    {
      name: "LaunchDarkly React SDK",
      importPattern: "@launchdarkly/react-client-sdk",
      description: "LaunchDarkly React SDK",
      enabled: true,
      methods: [
        { name: "useFlags", flagKeyIndex: -1, examples: ["const { flagKey } = useFlags()"] },
        { name: "useLDClient", flagKeyIndex: -1, examples: ["const ldClient = useLDClient()"] }
      ]
    },
    {
      name: "LaunchDarkly Legacy Node SDK",
      importPattern: "launchdarkly-node-server-sdk",
      description: "LaunchDarkly legacy Node.js Server SDK",
      enabled: true,
      methods: [
        {
          name: "variation",
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", context, defaultValue)']
        },
        {
          name: "boolVariation",
          flagKeyIndex: 0,
          examples: ['client.boolVariation("flag-key", context, false)']
        }
      ]
    },
    {
      name: "Unleash JavaScript SDK",
      importPattern: "unleash-client",
      description: "Unleash JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        { name: "isEnabled", flagKeyIndex: 0, examples: ['unleash.isEnabled("feature-toggle")'] },
        { name: "getVariant", flagKeyIndex: 0, examples: ['unleash.getVariant("feature-toggle")'] }
      ]
    },
    {
      name: "Split.io JavaScript SDK",
      importPattern: "@splitsoftware/splitio",
      description: "Split.io JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        {
          name: "getTreatment",
          flagKeyIndex: 1,
          examples: ['client.getTreatment(key, "split-name")']
        }
      ]
    },
    {
      name: "React Feature Flags",
      importPattern: "react-feature-flags",
      description: "React feature flags library",
      enabled: true,
      methods: [{ name: "Flag", flagKeyIndex: 0, examples: ['<Flag name="new-feature">'] }]
    },
    {
      name: "Optimizely JavaScript SDK",
      importPattern: "@optimizely/optimizely-sdk",
      description: "Optimizely Feature Experimentation JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        { name: "decide", flagKeyIndex: 0, examples: ['user.decide("flag-key", options)'] },
        {
          name: "decideForKeys",
          flagKeyIndex: 0,
          examples: ['user.decideForKeys(["flag-key-1", "flag-key-2"], options)']
        },
        { name: "decideAll", flagKeyIndex: 0, examples: ["user.decideAll(options)"] }
      ]
    },
    {
      name: "Flagsmith JavaScript SDK",
      importPattern: "flagsmith",
      description: "Flagsmith JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        { name: "hasFeature", flagKeyIndex: 0, examples: ['flagsmith.hasFeature("feature-name")'] },
        { name: "getValue", flagKeyIndex: 0, examples: ['flagsmith.getValue("feature-name")'] }
      ]
    },
    {
      name: "ConfigCat JavaScript SDK",
      importPattern: "configcat-js",
      description: "ConfigCat JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        {
          name: "getValue",
          flagKeyIndex: 0,
          examples: ['client.getValue("flag-key", defaultValue)']
        },
        {
          name: "getValueAsync",
          flagKeyIndex: 0,
          examples: ['await client.getValueAsync("flag-key", defaultValue)']
        }
      ]
    },
    {
      name: "Flipt JavaScript SDK",
      importPattern: "@flipt-io/flipt-client-js",
      description: "Flipt JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        {
          name: "evaluateBoolean",
          flagKeyIndex: 0,
          examples: ['client.evaluateBoolean("flag-key", entityId, context)']
        },
        {
          name: "evaluateVariant",
          flagKeyIndex: 0,
          examples: ['client.evaluateVariant("flag-key", entityId, context)']
        }
      ]
    },
    {
      name: "Statsig JavaScript SDK",
      importPattern: "statsig-js",
      description: "Statsig JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        { name: "checkGate", flagKeyIndex: 0, examples: ['statsig.checkGate("gate-name")'] },
        {
          name: "getExperiment",
          flagKeyIndex: 0,
          examples: ['statsig.getExperiment("experiment-name")']
        },
        { name: "getConfig", flagKeyIndex: 0, examples: ['statsig.getConfig("config-name")'] }
      ]
    },
    {
      name: "GrowthBook JavaScript SDK",
      importPattern: "@growthbook/growthbook",
      description: "GrowthBook JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        { name: "isOn", flagKeyIndex: 0, examples: ['gb.isOn("feature-key")'] },
        {
          name: "getFeatureValue",
          flagKeyIndex: 0,
          examples: ['gb.getFeatureValue("feature-key", fallbackValue)']
        },
        { name: "evalFeature", flagKeyIndex: 0, examples: ['gb.evalFeature("feature-key")'] }
      ]
    },
    {
      name: "DevCycle JavaScript SDK",
      importPattern: "@devcycle/js-client-sdk",
      description: "DevCycle JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        {
          name: "variableValue",
          flagKeyIndex: 0,
          examples: ['client.variableValue("variable-key", defaultValue)']
        },
        {
          name: "variable",
          flagKeyIndex: 0,
          examples: ['client.variable("variable-key", defaultValue)']
        }
      ]
    },
    {
      name: "Eppo JavaScript SDK",
      importPattern: "@eppo/js-client-sdk",
      description: "Eppo JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        {
          name: "getBooleanAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getBooleanAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "getStringAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getStringAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "getNumericAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getNumericAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "getJSONAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getJSONAssignment("flag-key", subjectKey, defaultValue)']
        }
      ]
    },
    {
      name: "PostHog JavaScript SDK",
      importPattern: "posthog-js",
      description: "PostHog JavaScript/TypeScript SDK",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['posthog.isFeatureEnabled("flag-key")']
        },
        {
          name: "getFeatureFlag",
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlag("flag-key")']
        },
        {
          name: "getFeatureFlagPayload",
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlagPayload("flag-key")']
        }
      ]
    },
    {
      name: "PostHog Node SDK",
      importPattern: "posthog-node",
      description: "PostHog Node.js SDK",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['posthog.isFeatureEnabled("flag-key", distinctId)']
        },
        {
          name: "getFeatureFlag",
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlag("flag-key", distinctId)']
        },
        {
          name: "getFeatureFlagPayload",
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlagPayload("flag-key", distinctId)']
        },
        { name: "getAllFlags", flagKeyIndex: -1, examples: ["posthog.getAllFlags(distinctId)"] }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")']
        },
        { name: "featureFlag", flagKeyIndex: 0, examples: ['featureFlag("feature-name")'] },
        { name: "hasFeature", flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/javascript.ts
var JavaScriptDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultTypeScriptProviders();
  }
  language() {
    return Languages.JavaScript;
  }
  fileExtensions() {
    return [".js", ".jsx", ".mjs", ".cjs"];
  }
  supportsFile(filename) {
    const ext = filename.toLowerCase().split(".").pop();
    return ["js", "jsx", "mjs", "cjs"].includes(ext ?? "");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};

// src/detection/detectors/kotlin.ts
var KotlinDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultKotlinProviders();
  }
  language() {
    return Languages.Kotlin;
  }
  fileExtensions() {
    return [".kt", ".kts"];
  }
  supportsFile(filename) {
    const lower = filename.toLowerCase();
    return lower.endsWith(".kt") || lower.endsWith(".kts");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultKotlinProviders() {
  return [
    {
      name: "LaunchDarkly Kotlin SDK",
      importPattern: "com.launchdarkly.sdk",
      description: "LaunchDarkly Kotlin/Android SDK",
      enabled: true,
      methods: [
        {
          name: "boolVariation",
          flagKeyIndex: 0,
          examples: ['client.boolVariation("flag-key", context, false)']
        },
        {
          name: "stringVariation",
          flagKeyIndex: 0,
          examples: ['client.stringVariation("flag-key", context, "default")']
        },
        {
          name: "intVariation",
          flagKeyIndex: 0,
          examples: ['client.intVariation("flag-key", context, 0)']
        }
      ]
    },
    {
      name: "Unleash Kotlin SDK",
      importPattern: "io.getunleash",
      description: "Unleash Kotlin/Android SDK",
      enabled: true,
      methods: [
        { name: "isEnabled", flagKeyIndex: 0, examples: ['unleash.isEnabled("feature-toggle")'] },
        { name: "getVariant", flagKeyIndex: 0, examples: ['unleash.getVariant("feature-toggle")'] }
      ]
    },
    {
      name: "Split.io Kotlin SDK",
      importPattern: "io.split.android",
      description: "Split.io Android/Kotlin SDK",
      enabled: true,
      methods: [
        { name: "getTreatment", flagKeyIndex: 0, examples: ['client.getTreatment("split-name")'] }
      ]
    },
    {
      name: "Flipt Kotlin SDK",
      importPattern: "io.flipt",
      description: "Flipt Kotlin SDK",
      enabled: true,
      methods: [
        {
          name: "evaluateBoolean",
          flagKeyIndex: 0,
          examples: ['flipt.evaluateBoolean("flag-key", entityId, context)']
        },
        {
          name: "evaluateVariant",
          flagKeyIndex: 0,
          examples: ['flipt.evaluateVariant("flag-key", entityId, context)']
        }
      ]
    },
    {
      name: "Optimizely Kotlin SDK",
      importPattern: "com.optimizely.ab",
      description: "Optimizely Feature Experimentation Kotlin SDK",
      enabled: true,
      methods: [
        { name: "decide", flagKeyIndex: 0, examples: ['user.decide("flag-key", options)'] },
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['optimizely.isFeatureEnabled("feature-key", userId)']
        }
      ]
    },
    {
      name: "ConfigCat Kotlin SDK",
      importPattern: "com.configcat",
      description: "ConfigCat Kotlin/Android SDK",
      enabled: true,
      methods: [
        { name: "getValue", flagKeyIndex: 0, examples: ['client.getValue("flag-key", false)'] }
      ]
    },
    {
      name: "Statsig Kotlin SDK",
      importPattern: "com.statsig",
      description: "Statsig Kotlin/Android SDK",
      enabled: true,
      methods: [
        { name: "checkGate", flagKeyIndex: 0, examples: ['statsig.checkGate("gate-name")'] },
        {
          name: "getExperiment",
          flagKeyIndex: 0,
          examples: ['statsig.getExperiment("experiment-name")']
        },
        { name: "getConfig", flagKeyIndex: 0, examples: ['statsig.getConfig("config-name")'] }
      ]
    },
    {
      name: "GrowthBook Kotlin SDK",
      importPattern: "growthbook.sdk",
      description: "GrowthBook Kotlin/Android SDK",
      enabled: true,
      methods: [
        { name: "feature", flagKeyIndex: 0, examples: ['gb.feature("feature-key").on'] },
        { name: "isOn", flagKeyIndex: 0, examples: ['gb.isOn("feature-key")'] }
      ]
    },
    {
      name: "DevCycle Kotlin SDK",
      importPattern: "com.devcycle",
      description: "DevCycle Kotlin/Android SDK",
      enabled: true,
      methods: [
        {
          name: "variableValue",
          flagKeyIndex: 0,
          examples: ['client.variableValue("variable-key", defaultValue)']
        },
        { name: "variable", flagKeyIndex: 0, examples: ['client.variable("variable-key")'] }
      ]
    },
    {
      name: "Eppo Kotlin SDK",
      importPattern: "com.eppo",
      description: "Eppo Kotlin/Android SDK",
      enabled: true,
      methods: [
        {
          name: "getBooleanAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getBooleanAssignment("flag-key", subjectKey, defaultValue)']
        },
        {
          name: "getStringAssignment",
          flagKeyIndex: 0,
          examples: ['eppoClient.getStringAssignment("flag-key", subjectKey, defaultValue)']
        }
      ]
    },
    {
      name: "PostHog Android SDK",
      importPattern: "com.posthog.android",
      description: "PostHog Android/Kotlin SDK",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['PostHog.isFeatureEnabled("flag-key")']
        },
        {
          name: "getFeatureFlag",
          flagKeyIndex: 0,
          examples: ['PostHog.getFeatureFlag("flag-key")']
        },
        {
          name: "getFeatureFlagPayload",
          flagKeyIndex: 0,
          examples: ['PostHog.getFeatureFlagPayload("flag-key")']
        }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom Kotlin feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")']
        },
        { name: "checkFeature", flagKeyIndex: 0, examples: ['checkFeature("feature-name")'] },
        { name: "hasFeature", flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/objectivec.ts
var ObjectiveCDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultObjCProviders();
  }
  language() {
    return Languages.ObjectiveC;
  }
  fileExtensions() {
    return [".m", ".mm", ".h"];
  }
  supportsFile(filename) {
    const lower = filename.toLowerCase();
    return lower.endsWith(".m") || lower.endsWith(".mm") || lower.endsWith(".h");
  }
  detectFlags(filename, content) {
    const flags = detectFlagsWithRegex(filename, content, this.language(), this.providers);
    const validFlags = flags.filter((f) => isValidFlagKey(f.name));
    return deduplicateFlags(validFlags);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultObjCProviders() {
  return [
    {
      name: "LaunchDarkly iOS SDK (Objective-C)",
      importPattern: "LaunchDarkly/LDClient.h",
      description: "LaunchDarkly iOS SDK for Objective-C",
      enabled: true,
      methods: [
        {
          name: "boolVariation",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] boolVariation:@"flag-key" defaultValue:NO]']
        },
        {
          name: "boolVariationForKey",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] boolVariationForKey:@"flag-key" defaultValue:NO]']
        },
        {
          name: "stringVariation",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] stringVariation:@"flag-key" defaultValue:@""]']
        },
        {
          name: "stringVariationForKey",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] stringVariationForKey:@"flag-key" defaultValue:@""]']
        },
        {
          name: "numberVariation",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] numberVariation:@"flag-key" defaultValue:@0]']
        },
        {
          name: "numberVariationForKey",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] numberVariationForKey:@"flag-key" defaultValue:@0]']
        },
        {
          name: "jsonVariation",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] jsonVariation:@"flag-key" defaultValue:nil]']
        },
        {
          name: "jsonVariationForKey",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] jsonVariationForKey:@"flag-key" defaultValue:nil]']
        },
        {
          name: "variationDetail",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] variationDetail:@"flag-key" defaultValue:NO]']
        },
        {
          name: "variationDetailForKey",
          flagKeyIndex: 0,
          examples: ['[[LDClient get] variationDetailForKey:@"flag-key" defaultValue:NO]']
        }
      ]
    },
    {
      name: "Unleash iOS SDK (Objective-C)",
      importPattern: "UnleashProxyClientSwift",
      description: "Unleash iOS SDK for Objective-C",
      enabled: true,
      methods: [
        { name: "isEnabled", flagKeyIndex: 0, examples: ['[unleash isEnabled:@"feature-toggle"]'] },
        {
          name: "getVariant",
          flagKeyIndex: 0,
          examples: ['[unleash getVariant:@"feature-toggle"]']
        }
      ]
    },
    {
      name: "Split.io iOS SDK (Objective-C)",
      importPattern: "Split/Split.h",
      description: "Split.io iOS SDK for Objective-C",
      enabled: true,
      methods: [
        {
          name: "getTreatment",
          flagKeyIndex: 0,
          examples: ['[splitClient getTreatment:@"split-name"]']
        },
        {
          name: "getTreatmentWithConfig",
          flagKeyIndex: 0,
          examples: ['[splitClient getTreatmentWithConfig:@"split-name"]']
        },
        {
          name: "getTreatments",
          flagKeyIndex: 0,
          examples: ['[splitClient getTreatments:@[@"split-1", @"split-2"]]']
        }
      ]
    },
    {
      name: "Optimizely iOS SDK (Objective-C)",
      importPattern: "Optimizely/Optimizely.h",
      description: "Optimizely Feature Experimentation iOS SDK for Objective-C",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['[optimizely isFeatureEnabled:@"feature-key" userId:userId attributes:nil]']
        },
        {
          name: "getFeatureVariable",
          flagKeyIndex: 0,
          examples: [
            '[optimizely getFeatureVariable:@"feature-key" variableKey:@"var" userId:userId]'
          ]
        },
        { name: "decide", flagKeyIndex: 0, examples: ['[user decide:@"flag-key" options:nil]'] }
      ]
    },
    {
      name: "Flagsmith iOS SDK (Objective-C)",
      importPattern: "FlagsmithClient",
      description: "Flagsmith iOS SDK for Objective-C",
      enabled: true,
      methods: [
        {
          name: "hasFeatureFlag",
          flagKeyIndex: 0,
          examples: ['[[Flagsmith shared] hasFeatureFlag:@"feature-name"]']
        },
        {
          name: "hasFeatureFlagWithID",
          flagKeyIndex: 0,
          examples: ['[[Flagsmith shared] hasFeatureFlagWithID:@"feature-name"]']
        },
        {
          name: "getValueForFeature",
          flagKeyIndex: 0,
          examples: ['[[Flagsmith shared] getValueForFeature:@"feature-name"]']
        }
      ]
    },
    {
      name: "ConfigCat iOS SDK (Objective-C)",
      importPattern: "ConfigCat/ConfigCat.h",
      description: "ConfigCat iOS SDK for Objective-C",
      enabled: true,
      methods: [
        {
          name: "getValue",
          flagKeyIndex: 0,
          examples: ['[configCatClient getValue:@"flag-key" defaultValue:@NO]']
        },
        {
          name: "getValueForKey",
          flagKeyIndex: 0,
          examples: ['[configCatClient getValueForKey:@"flag-key" defaultValue:@NO]']
        }
      ]
    },
    {
      name: "PostHog iOS SDK (Objective-C)",
      importPattern: "PostHog/PostHog.h",
      description: "PostHog iOS SDK for Objective-C",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['[[PHGPostHog sharedInstance] isFeatureEnabled:@"flag-key"]']
        },
        {
          name: "getFeatureFlag",
          flagKeyIndex: 0,
          examples: ['[[PHGPostHog sharedInstance] getFeatureFlag:@"flag-key"]']
        },
        {
          name: "getFeatureFlagPayload",
          flagKeyIndex: 0,
          examples: ['[[PHGPostHog sharedInstance] getFeatureFlagPayload:@"flag-key"]']
        }
      ]
    },
    {
      name: "Custom Feature Flags (Objective-C)",
      description: "Common custom Objective-C feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['[featureFlags isFeatureEnabled:@"feature-name"]']
        },
        {
          name: "checkFeature",
          flagKeyIndex: 0,
          examples: ['[featureFlags checkFeature:@"feature-name"]']
        },
        {
          name: "hasFeature",
          flagKeyIndex: 0,
          examples: ['[featureFlags hasFeature:@"feature-name"]']
        },
        {
          name: "featureEnabled",
          flagKeyIndex: 0,
          examples: ['[flags featureEnabled:@"feature-name"]']
        }
      ]
    }
  ];
}

// src/detection/detectors/php.ts
var PHPDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultPHPProviders();
  }
  language() {
    return Languages.PHP;
  }
  fileExtensions() {
    return [".php", ".phtml", ".php3", ".php4", ".php5", ".phps"];
  }
  supportsFile(filename) {
    const ext = filename.toLowerCase().split(".").pop();
    return ["php", "phtml", "php3", "php4", "php5", "phps"].includes(ext ?? "");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultPHPProviders() {
  return [
    {
      name: "LaunchDarkly PHP SDK",
      importPattern: "LaunchDarkly\\",
      description: "LaunchDarkly PHP SDK",
      enabled: true,
      methods: [
        {
          name: "variation",
          flagKeyIndex: 0,
          examples: ['$client->variation("flag-key", $context, false)']
        },
        {
          name: "boolVariation",
          flagKeyIndex: 0,
          examples: ['$client->boolVariation("flag-key", $context, false)']
        },
        {
          name: "stringVariation",
          flagKeyIndex: 0,
          examples: ['$client->stringVariation("flag-key", $context, "default")']
        },
        {
          name: "intVariation",
          flagKeyIndex: 0,
          examples: ['$client->intVariation("flag-key", $context, 0)']
        },
        {
          name: "floatVariation",
          flagKeyIndex: 0,
          examples: ['$client->floatVariation("flag-key", $context, 0.0)']
        },
        {
          name: "jsonVariation",
          flagKeyIndex: 0,
          examples: ['$client->jsonVariation("flag-key", $context, [])']
        }
      ]
    },
    {
      name: "Unleash PHP SDK",
      importPattern: "Unleash\\Client",
      description: "Unleash PHP SDK",
      enabled: true,
      methods: [
        { name: "isEnabled", flagKeyIndex: 0, examples: ['$unleash->isEnabled("feature-toggle")'] },
        {
          name: "getVariant",
          flagKeyIndex: 0,
          examples: ['$unleash->getVariant("feature-toggle")']
        }
      ]
    },
    {
      name: "Split.io PHP SDK",
      importPattern: "SplitIO\\",
      description: "Split.io PHP SDK",
      enabled: true,
      methods: [
        {
          name: "getTreatment",
          flagKeyIndex: 1,
          examples: ['$client->getTreatment($key, "split-name")']
        },
        {
          name: "getTreatments",
          flagKeyIndex: 1,
          examples: ['$client->getTreatments($key, ["split1", "split2"])']
        }
      ]
    },
    {
      name: "Flagsmith PHP SDK",
      importPattern: "Flagsmith\\",
      description: "Flagsmith PHP SDK",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['$flags->isFeatureEnabled("feature-name")']
        },
        {
          name: "getFeatureValue",
          flagKeyIndex: 0,
          examples: ['$flags->getFeatureValue("feature-name")']
        }
      ]
    },
    {
      name: "ConfigCat PHP SDK",
      importPattern: "ConfigCat\\",
      description: "ConfigCat PHP SDK",
      enabled: true,
      methods: [
        { name: "getValue", flagKeyIndex: 0, examples: ['$client->getValue("flag-key", false)'] }
      ]
    },
    {
      name: "Statsig PHP SDK",
      importPattern: "Statsig\\",
      description: "Statsig PHP SDK",
      enabled: true,
      methods: [
        {
          name: "checkGate",
          flagKeyIndex: 1,
          examples: ['Statsig::checkGate($user, "gate-name")']
        },
        {
          name: "getExperiment",
          flagKeyIndex: 1,
          examples: ['Statsig::getExperiment($user, "experiment-name")']
        },
        {
          name: "getConfig",
          flagKeyIndex: 1,
          examples: ['Statsig::getConfig($user, "config-name")']
        }
      ]
    },
    {
      name: "GrowthBook PHP SDK",
      importPattern: "Growthbook\\",
      description: "GrowthBook PHP SDK",
      enabled: true,
      methods: [
        { name: "isOn", flagKeyIndex: 0, examples: ['$gb->isOn("feature-key")'] },
        {
          name: "getFeatureValue",
          flagKeyIndex: 0,
          examples: ['$gb->getFeatureValue("feature-key", $fallbackValue)']
        }
      ]
    },
    {
      name: "PostHog PHP SDK",
      importPattern: "PostHog\\",
      description: "PostHog PHP SDK",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['PostHog::isFeatureEnabled("flag-key", $distinctId)']
        },
        {
          name: "getFeatureFlag",
          flagKeyIndex: 0,
          examples: ['PostHog::getFeatureFlag("flag-key", $distinctId)']
        }
      ]
    },
    {
      name: "Laravel Pennant",
      importPattern: "Laravel\\Pennant",
      description: "Laravel Pennant feature flags",
      enabled: true,
      methods: [
        { name: "active", flagKeyIndex: 0, examples: ['Feature::active("feature-name")'] },
        { name: "inactive", flagKeyIndex: 0, examples: ['Feature::inactive("feature-name")'] },
        { name: "value", flagKeyIndex: 0, examples: ['Feature::value("feature-name")'] }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom PHP feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")']
        },
        { name: "feature_enabled", flagKeyIndex: 0, examples: ['feature_enabled("feature-name")'] },
        { name: "hasFeature", flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/python.ts
var PythonDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultPythonProviders();
  }
  language() {
    return Languages.Python;
  }
  fileExtensions() {
    return [".py", ".pyw", ".pyx", ".pyi"];
  }
  supportsFile(filename) {
    const ext = filename.toLowerCase().split(".").pop();
    return ["py", "pyw", "pyx", "pyi"].includes(ext ?? "");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultPythonProviders() {
  return [
    {
      name: "LaunchDarkly Python SDK",
      importPattern: "ldclient",
      description: "LaunchDarkly Python SDK",
      enabled: true,
      methods: [
        {
          name: "variation",
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", user, default_value)']
        },
        {
          name: "bool_variation",
          flagKeyIndex: 0,
          examples: ['client.bool_variation("flag-key", user, False)']
        }
      ]
    },
    {
      name: "Unleash Python SDK",
      importPattern: "UnleashClient",
      description: "Unleash Python SDK",
      enabled: true,
      methods: [
        { name: "is_enabled", flagKeyIndex: 0, examples: ['unleash.is_enabled("feature-toggle")'] },
        {
          name: "get_variant",
          flagKeyIndex: 0,
          examples: ['unleash.get_variant("feature-toggle")']
        }
      ]
    },
    {
      name: "Split.io Python SDK",
      importPattern: "splitio",
      description: "Split.io Python SDK",
      enabled: true,
      methods: [
        {
          name: "get_treatment",
          flagKeyIndex: 1,
          examples: ['client.get_treatment(key, "split-name")']
        }
      ]
    },
    {
      name: "Flipt Python SDK",
      importPattern: "flipt",
      description: "Flipt Python SDK",
      enabled: true,
      methods: [
        {
          name: "evaluate_boolean",
          flagKeyIndex: 0,
          examples: ['flipt.evaluate_boolean("flag-key", entity_id)']
        },
        {
          name: "evaluate_variant",
          flagKeyIndex: 0,
          examples: ['flipt.evaluate_variant("flag-key", entity_id)']
        }
      ]
    },
    {
      name: "Django Feature Flags",
      importPattern: "django_feature_flags",
      description: "Django feature flags",
      enabled: true,
      methods: [
        { name: "flag_enabled", flagKeyIndex: 0, examples: ['flag_enabled("feature-name")'] },
        { name: "flag_disabled", flagKeyIndex: 0, examples: ['flag_disabled("feature-name")'] }
      ]
    },
    {
      name: "Optimizely Python SDK",
      importPattern: "optimizely",
      description: "Optimizely Feature Experimentation Python SDK",
      enabled: true,
      methods: [
        { name: "decide", flagKeyIndex: 0, examples: ['user.decide("flag-key", options)'] },
        {
          name: "decide_for_keys",
          flagKeyIndex: 0,
          examples: ['user.decide_for_keys(["flag-key-1", "flag-key-2"], options)']
        },
        { name: "decide_all", flagKeyIndex: 0, examples: ["user.decide_all(options)"] }
      ]
    },
    {
      name: "Flagsmith Python SDK",
      importPattern: "flagsmith",
      description: "Flagsmith Python SDK",
      enabled: true,
      methods: [
        {
          name: "is_feature_enabled",
          flagKeyIndex: 0,
          examples: ['identity_flags.is_feature_enabled("feature-name")']
        },
        {
          name: "get_feature_value",
          flagKeyIndex: 0,
          examples: ['identity_flags.get_feature_value("feature-name")']
        }
      ]
    },
    {
      name: "ConfigCat Python SDK",
      importPattern: "configcatclient",
      description: "ConfigCat Python SDK",
      enabled: true,
      methods: [
        {
          name: "get_value",
          flagKeyIndex: 0,
          examples: ['client.get_value("flag-key", default_value)']
        },
        {
          name: "get_value_details",
          flagKeyIndex: 0,
          examples: ['client.get_value_details("flag-key", default_value)']
        }
      ]
    },
    {
      name: "Statsig Python SDK",
      importPattern: "statsig",
      description: "Statsig Python SDK",
      enabled: true,
      methods: [
        {
          name: "check_gate",
          flagKeyIndex: 1,
          examples: ['statsig.check_gate(user, "gate-name")']
        },
        {
          name: "get_experiment",
          flagKeyIndex: 1,
          examples: ['statsig.get_experiment(user, "experiment-name")']
        },
        {
          name: "get_config",
          flagKeyIndex: 1,
          examples: ['statsig.get_config(user, "config-name")']
        }
      ]
    },
    {
      name: "GrowthBook Python SDK",
      importPattern: "growthbook",
      description: "GrowthBook Python SDK",
      enabled: true,
      methods: [
        { name: "is_on", flagKeyIndex: 0, examples: ['gb.is_on("feature-key")'] },
        {
          name: "get_feature_value",
          flagKeyIndex: 0,
          examples: ['gb.get_feature_value("feature-key", fallback_value)']
        },
        { name: "eval_feature", flagKeyIndex: 0, examples: ['gb.eval_feature("feature-key")'] }
      ]
    },
    {
      name: "DevCycle Python SDK",
      importPattern: "devcycle_python_sdk",
      description: "DevCycle Python SDK",
      enabled: true,
      methods: [
        {
          name: "variable_value",
          flagKeyIndex: 1,
          examples: ['client.variable_value(user, "variable-key", default_value)']
        },
        {
          name: "variable",
          flagKeyIndex: 1,
          examples: ['client.variable(user, "variable-key", default_value)']
        }
      ]
    },
    {
      name: "Eppo Python SDK",
      importPattern: "eppo_client",
      description: "Eppo Python SDK",
      enabled: true,
      methods: [
        {
          name: "get_boolean_assignment",
          flagKeyIndex: 0,
          examples: ['eppo_client.get_boolean_assignment("flag-key", subject_key, default_value)']
        },
        {
          name: "get_string_assignment",
          flagKeyIndex: 0,
          examples: ['eppo_client.get_string_assignment("flag-key", subject_key, default_value)']
        },
        {
          name: "get_numeric_assignment",
          flagKeyIndex: 0,
          examples: ['eppo_client.get_numeric_assignment("flag-key", subject_key, default_value)']
        },
        {
          name: "get_json_assignment",
          flagKeyIndex: 0,
          examples: ['eppo_client.get_json_assignment("flag-key", subject_key, default_value)']
        }
      ]
    },
    {
      name: "PostHog Python SDK",
      importPattern: "posthog",
      description: "PostHog Python SDK",
      enabled: true,
      methods: [
        {
          name: "feature_enabled",
          flagKeyIndex: 0,
          examples: ['posthog.feature_enabled("flag-key", distinct_id)']
        },
        {
          name: "get_feature_flag",
          flagKeyIndex: 0,
          examples: ['posthog.get_feature_flag("flag-key", distinct_id)']
        },
        {
          name: "get_feature_flag_payload",
          flagKeyIndex: 0,
          examples: ['posthog.get_feature_flag_payload("flag-key", distinct_id)']
        },
        {
          name: "get_all_flags",
          flagKeyIndex: 0,
          examples: ["posthog.get_all_flags(distinct_id)"]
        }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom Python feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "is_feature_enabled",
          flagKeyIndex: 0,
          examples: ['is_feature_enabled("feature-name")']
        },
        { name: "feature_flag", flagKeyIndex: 0, examples: ['feature_flag("feature-name")'] },
        { name: "has_feature", flagKeyIndex: 0, examples: ['has_feature("feature-name")'] },
        { name: "check_feature", flagKeyIndex: 0, examples: ['check_feature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/ruby.ts
var RubyDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultRubyProviders();
  }
  language() {
    return Languages.Ruby;
  }
  fileExtensions() {
    return [".rb", ".rake", ".gemspec"];
  }
  supportsFile(filename) {
    const lower = filename.toLowerCase();
    const ext = lower.split(".").pop();
    if (["rb", "rake", "gemspec"].includes(ext ?? "")) {
      return true;
    }
    const baseName = lower.split("/").pop() ?? "";
    return baseName === "rakefile" || baseName === "gemfile";
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultRubyProviders() {
  return [
    {
      name: "LaunchDarkly Ruby SDK",
      importPattern: "launchdarkly-server-sdk",
      description: "LaunchDarkly Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "variation",
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", context, default_value)']
        },
        {
          name: "variation_detail",
          flagKeyIndex: 0,
          examples: ['client.variation_detail("flag-key", context, default_value)']
        }
      ]
    },
    {
      name: "Unleash Ruby SDK",
      importPattern: "unleash",
      description: "Unleash Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "is_enabled?",
          flagKeyIndex: 0,
          examples: ['UNLEASH.is_enabled?("feature-toggle")']
        },
        {
          name: "enabled?",
          flagKeyIndex: 0,
          examples: ['UNLEASH.enabled?("feature-toggle", context)']
        },
        {
          name: "get_variant",
          flagKeyIndex: 0,
          examples: ['UNLEASH.get_variant("feature-toggle", context)']
        }
      ]
    },
    {
      name: "Split.io Ruby SDK",
      importPattern: "splitclient-rb",
      description: "Split.io Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "get_treatment",
          flagKeyIndex: 1,
          examples: ['client.get_treatment(key, "split-name")']
        },
        {
          name: "get_treatments",
          flagKeyIndex: 1,
          examples: ['client.get_treatments(key, ["split1", "split2"])']
        }
      ]
    },
    {
      name: "Flipper",
      importPattern: "flipper",
      description: "Flipper feature flags for Ruby",
      enabled: true,
      methods: [
        { name: "enabled?", flagKeyIndex: 0, examples: ["Flipper.enabled?(:feature_name)"] },
        { name: "disabled?", flagKeyIndex: 0, examples: ["Flipper.disabled?(:feature_name)"] }
      ]
    },
    {
      name: "Optimizely Ruby SDK",
      importPattern: "optimizely-sdk",
      description: "Optimizely Feature Experimentation Ruby SDK",
      enabled: true,
      methods: [
        { name: "decide", flagKeyIndex: 0, examples: ['user.decide("flag-key")'] },
        {
          name: "is_feature_enabled",
          flagKeyIndex: 0,
          examples: ['optimizely.is_feature_enabled("feature-key", user_id)']
        }
      ]
    },
    {
      name: "Flagsmith Ruby SDK",
      importPattern: "flagsmith",
      description: "Flagsmith Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "is_feature_enabled",
          flagKeyIndex: 0,
          examples: ['flags.is_feature_enabled("feature-name")']
        },
        {
          name: "get_feature_value",
          flagKeyIndex: 0,
          examples: ['flags.get_feature_value("feature-name")']
        }
      ]
    },
    {
      name: "ConfigCat Ruby SDK",
      importPattern: "configcat",
      description: "ConfigCat Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "get_value",
          flagKeyIndex: 0,
          examples: ['client.get_value("flag-key", default_value)']
        }
      ]
    },
    {
      name: "Statsig Ruby SDK",
      importPattern: "statsig",
      description: "Statsig Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "check_gate",
          flagKeyIndex: 1,
          examples: ['Statsig.check_gate(user, "gate-name")']
        },
        {
          name: "get_experiment",
          flagKeyIndex: 1,
          examples: ['Statsig.get_experiment(user, "experiment-name")']
        },
        {
          name: "get_config",
          flagKeyIndex: 1,
          examples: ['Statsig.get_config(user, "config-name")']
        }
      ]
    },
    {
      name: "GrowthBook Ruby SDK",
      importPattern: "growthbook",
      description: "GrowthBook Ruby SDK",
      enabled: true,
      methods: [
        { name: "on?", flagKeyIndex: 0, examples: ["gb.on?(:feature_key)"] },
        {
          name: "feature_value",
          flagKeyIndex: 0,
          examples: ["gb.feature_value(:feature_key, fallback_value)"]
        }
      ]
    },
    {
      name: "DevCycle Ruby SDK",
      importPattern: "devcycle-ruby-server-sdk",
      description: "DevCycle Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "variable_value",
          flagKeyIndex: 1,
          examples: ['client.variable_value(user, "variable-key", default_value)']
        },
        { name: "variable", flagKeyIndex: 1, examples: ['client.variable(user, "variable-key")'] }
      ]
    },
    {
      name: "Eppo Ruby SDK",
      importPattern: "eppo_client",
      description: "Eppo Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "get_boolean_assignment",
          flagKeyIndex: 0,
          examples: ['eppo_client.get_boolean_assignment("flag-key", subject_key, default_value)']
        },
        {
          name: "get_string_assignment",
          flagKeyIndex: 0,
          examples: ['eppo_client.get_string_assignment("flag-key", subject_key, default_value)']
        }
      ]
    },
    {
      name: "PostHog Ruby SDK",
      importPattern: "posthog-ruby",
      description: "PostHog Ruby SDK",
      enabled: true,
      methods: [
        {
          name: "is_feature_enabled",
          flagKeyIndex: 0,
          examples: ['posthog.is_feature_enabled("flag-key", distinct_id)']
        },
        {
          name: "get_feature_flag",
          flagKeyIndex: 0,
          examples: ['posthog.get_feature_flag("flag-key", distinct_id)']
        },
        {
          name: "get_feature_flag_payload",
          flagKeyIndex: 0,
          examples: ['posthog.get_feature_flag_payload("flag-key", distinct_id)']
        }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom Ruby feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "feature_enabled?",
          flagKeyIndex: 0,
          examples: ['feature_enabled?("feature-name")']
        },
        { name: "enabled?", flagKeyIndex: 0, examples: ['enabled?("feature-name")'] },
        { name: "has_feature?", flagKeyIndex: 0, examples: ['has_feature?("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/rust.ts
var RustDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultRustProviders();
  }
  language() {
    return Languages.Rust;
  }
  fileExtensions() {
    return [".rs"];
  }
  supportsFile(filename) {
    return filename.toLowerCase().endsWith(".rs");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultRustProviders() {
  return [
    {
      name: "LaunchDarkly Rust SDK",
      importPattern: "launchdarkly_server_sdk",
      description: "LaunchDarkly Rust Server SDK",
      enabled: true,
      methods: [
        {
          name: "bool_variation",
          flagKeyIndex: 1,
          examples: ['client.bool_variation(&context, "flag-key", false)']
        },
        {
          name: "string_variation",
          flagKeyIndex: 1,
          examples: ['client.string_variation(&context, "flag-key", "default".to_string())']
        },
        {
          name: "int_variation",
          flagKeyIndex: 1,
          examples: ['client.int_variation(&context, "flag-key", 0)']
        },
        {
          name: "float_variation",
          flagKeyIndex: 1,
          examples: ['client.float_variation(&context, "flag-key", 0.0)']
        }
      ]
    },
    {
      name: "Unleash Rust SDK",
      importPattern: "unleash_api_client",
      description: "Unleash Rust SDK",
      enabled: true,
      methods: [
        {
          name: "is_enabled",
          flagKeyIndex: 0,
          examples: ['client.is_enabled("feature-toggle", None, false)']
        },
        {
          name: "get_variant",
          flagKeyIndex: 0,
          examples: ['client.get_variant("feature-toggle", None)']
        }
      ]
    },
    {
      name: "Flagsmith Rust SDK",
      importPattern: "flagsmith",
      description: "Flagsmith Rust SDK",
      enabled: true,
      methods: [
        {
          name: "is_feature_enabled",
          flagKeyIndex: 0,
          examples: ['flags.is_feature_enabled("feature-name")']
        },
        {
          name: "get_feature_value",
          flagKeyIndex: 0,
          examples: ['flags.get_feature_value("feature-name")']
        }
      ]
    },
    {
      name: "ConfigCat Rust SDK",
      importPattern: "configcat",
      description: "ConfigCat Rust SDK",
      enabled: true,
      methods: [
        {
          name: "get_value",
          flagKeyIndex: 0,
          examples: ['client.get_value("flag-key", false, None).await']
        }
      ]
    },
    {
      name: "GrowthBook Rust SDK",
      importPattern: "growthbook",
      description: "GrowthBook Rust SDK",
      enabled: true,
      methods: [
        { name: "is_on", flagKeyIndex: 0, examples: ['gb.is_on("feature-key")'] },
        {
          name: "get_feature_value",
          flagKeyIndex: 0,
          examples: ['gb.get_feature_value("feature-key", fallback_value)']
        }
      ]
    },
    {
      name: "Eppo Rust SDK",
      importPattern: "eppo",
      description: "Eppo Rust SDK",
      enabled: true,
      methods: [
        {
          name: "get_boolean_assignment",
          flagKeyIndex: 0,
          examples: [
            'eppo_client.get_boolean_assignment("flag-key", &subject_key, &subject_attributes, default_value)'
          ]
        },
        {
          name: "get_string_assignment",
          flagKeyIndex: 0,
          examples: [
            'eppo_client.get_string_assignment("flag-key", &subject_key, &subject_attributes, default_value)'
          ]
        }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom Rust feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "is_feature_enabled",
          flagKeyIndex: 0,
          examples: ['is_feature_enabled("feature-name")']
        },
        { name: "feature_enabled", flagKeyIndex: 0, examples: ['feature_enabled("feature-name")'] },
        { name: "has_feature", flagKeyIndex: 0, examples: ['has_feature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/detectors/swift.ts
var SwiftDetector = class {
  providers;
  constructor(providers) {
    this.providers = providers ?? defaultSwiftProviders();
  }
  language() {
    return Languages.Swift;
  }
  fileExtensions() {
    return [".swift"];
  }
  supportsFile(filename) {
    return filename.toLowerCase().endsWith(".swift");
  }
  detectFlags(filename, content) {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers);
  }
  getProviders() {
    return this.providers;
  }
};
function defaultSwiftProviders() {
  return [
    {
      name: "LaunchDarkly iOS SDK",
      importPattern: "LaunchDarkly",
      description: "LaunchDarkly iOS/macOS/tvOS SDK",
      enabled: true,
      methods: [
        {
          name: "variation",
          flagKeyIndex: 0,
          examples: ['LDClient.get()!.variation(forKey: "flag-key", defaultValue: false)']
        },
        {
          name: "boolVariation",
          flagKeyIndex: 0,
          examples: ['client.boolVariation(forKey: "flag-key", defaultValue: false)']
        },
        {
          name: "stringVariation",
          flagKeyIndex: 0,
          examples: ['client.stringVariation(forKey: "flag-key", defaultValue: "")']
        }
      ]
    },
    {
      name: "Unleash iOS SDK",
      importPattern: "UnleashProxyClientSwift",
      description: "Unleash iOS SDK",
      enabled: true,
      methods: [
        {
          name: "isEnabled",
          flagKeyIndex: 0,
          examples: ['unleash.isEnabled(name: "feature-toggle")']
        },
        {
          name: "getVariant",
          flagKeyIndex: 0,
          examples: ['unleash.getVariant(name: "feature-toggle")']
        }
      ]
    },
    {
      name: "Split.io iOS SDK",
      importPattern: "Split",
      description: "Split.io iOS SDK",
      enabled: true,
      methods: [
        { name: "getTreatment", flagKeyIndex: 0, examples: ['client.getTreatment("split-name")'] }
      ]
    },
    {
      name: "Optimizely iOS SDK",
      importPattern: "Optimizely",
      description: "Optimizely Feature Experimentation iOS SDK",
      enabled: true,
      methods: [
        { name: "decide", flagKeyIndex: 0, examples: ['user.decide(key: "flag-key")'] },
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['optimizely.isFeatureEnabled(featureKey: "feature-key", userId: userId)']
        }
      ]
    },
    {
      name: "Flagsmith iOS SDK",
      importPattern: "FlagsmithClient",
      description: "Flagsmith iOS SDK",
      enabled: true,
      methods: [
        {
          name: "hasFeatureFlag",
          flagKeyIndex: 0,
          examples: ['Flagsmith.shared.hasFeatureFlag(withID: "feature-name")']
        },
        {
          name: "getValueForFeature",
          flagKeyIndex: 0,
          examples: ['Flagsmith.shared.getValueForFeature(withID: "feature-name")']
        }
      ]
    },
    {
      name: "ConfigCat iOS SDK",
      importPattern: "ConfigCat",
      description: "ConfigCat iOS SDK",
      enabled: true,
      methods: [
        {
          name: "getValue",
          flagKeyIndex: 0,
          examples: ['client.getValue(for: "flag-key", defaultValue: false)']
        }
      ]
    },
    {
      name: "Statsig iOS SDK",
      importPattern: "StatsigOnDeviceEvaluations",
      description: "Statsig iOS/Swift SDK",
      enabled: true,
      methods: [
        { name: "checkGate", flagKeyIndex: 0, examples: ['statsig.checkGate("gate-name")'] },
        {
          name: "getExperiment",
          flagKeyIndex: 0,
          examples: ['statsig.getExperiment("experiment-name")']
        },
        { name: "getConfig", flagKeyIndex: 0, examples: ['statsig.getConfig("config-name")'] }
      ]
    },
    {
      name: "GrowthBook iOS SDK",
      importPattern: "GrowthBook",
      description: "GrowthBook iOS/Swift SDK",
      enabled: true,
      methods: [
        { name: "isOn", flagKeyIndex: 0, examples: ['gb.isOn(feature: "feature-key")'] },
        {
          name: "getFeatureValue",
          flagKeyIndex: 0,
          examples: ['gb.getFeatureValue(feature: "feature-key", default: JSON("blue"))']
        }
      ]
    },
    {
      name: "DevCycle iOS SDK",
      importPattern: "DevCycle",
      description: "DevCycle iOS/Swift SDK",
      enabled: true,
      methods: [
        {
          name: "variableValue",
          flagKeyIndex: 0,
          examples: ['client.variableValue(key: "variable-key", defaultValue: false)']
        },
        { name: "variable", flagKeyIndex: 0, examples: ['client.variable(key: "variable-key")'] }
      ]
    },
    {
      name: "Eppo iOS SDK",
      importPattern: "EppoClient",
      description: "Eppo iOS/Swift SDK",
      enabled: true,
      methods: [
        {
          name: "getBoolAssignment",
          flagKeyIndex: 0,
          examples: [
            'eppoClient.getBoolAssignment(flagKey: "flag-key", subjectKey: subjectKey, defaultValue: false)'
          ]
        },
        {
          name: "getStringAssignment",
          flagKeyIndex: 0,
          examples: [
            'eppoClient.getStringAssignment(flagKey: "flag-key", subjectKey: subjectKey, defaultValue: "")'
          ]
        }
      ]
    },
    {
      name: "PostHog iOS SDK",
      importPattern: "PostHog",
      description: "PostHog iOS/Swift SDK",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['PostHogSDK.shared.isFeatureEnabled("flag-key")']
        },
        {
          name: "getFeatureFlag",
          flagKeyIndex: 0,
          examples: ['PostHogSDK.shared.getFeatureFlag("flag-key")']
        },
        {
          name: "getFeatureFlagPayload",
          flagKeyIndex: 0,
          examples: ['PostHogSDK.shared.getFeatureFlagPayload("flag-key")']
        }
      ]
    },
    {
      name: "Custom Feature Flags",
      description: "Common custom Swift feature flag patterns",
      enabled: true,
      methods: [
        {
          name: "isFeatureEnabled",
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")']
        },
        { name: "checkFeature", flagKeyIndex: 0, examples: ['checkFeature("feature-name")'] },
        { name: "hasFeature", flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] }
      ]
    }
  ];
}

// src/detection/registry.ts
var LanguageRegistry = class {
  detectors = /* @__PURE__ */ new Map();
  /** Registers a language detector. Throws if a detector for the language is already registered. */
  register(detector) {
    const lang = detector.language();
    if (this.detectors.has(lang)) {
      throw new Error(`detector for language ${lang} already registered`);
    }
    this.detectors.set(lang, detector);
  }
  /** Returns the detector for a specific language, or undefined if not registered. */
  getDetector(lang) {
    return this.detectors.get(lang);
  }
  /** Returns the appropriate detector for a file based on its extension. */
  getDetectorForFile(filename) {
    for (const detector of this.detectors.values()) {
      if (detector.supportsFile(filename)) {
        return detector;
      }
    }
    return void 0;
  }
  /** Detects feature flags in a file using the appropriate language detector. */
  detectInFile(filename, content) {
    const detector = this.getDetectorForFile(filename);
    if (!detector) {
      return null;
    }
    return detector.detectFlags(filename, content);
  }
  /** Returns all registered languages. */
  getSupportedLanguages() {
    return Array.from(this.detectors.keys());
  }
  /** Returns all supported file extensions (deduplicated). */
  getSupportedExtensions() {
    const extensionSet = /* @__PURE__ */ new Set();
    for (const detector of this.detectors.values()) {
      for (const ext of detector.fileExtensions()) {
        extensionSet.add(ext);
      }
    }
    return Array.from(extensionSet);
  }
};

// node_modules/yocto-queue/index.js
var Node = class {
  value;
  next;
  constructor(value) {
    this.value = value;
  }
};
var Queue = class {
  #head;
  #tail;
  #size;
  constructor() {
    this.clear();
  }
  enqueue(value) {
    const node = new Node(value);
    if (this.#head) {
      this.#tail.next = node;
      this.#tail = node;
    } else {
      this.#head = node;
      this.#tail = node;
    }
    this.#size++;
  }
  dequeue() {
    const current = this.#head;
    if (!current) {
      return;
    }
    this.#head = this.#head.next;
    this.#size--;
    if (!this.#head) {
      this.#tail = void 0;
    }
    return current.value;
  }
  peek() {
    if (!this.#head) {
      return;
    }
    return this.#head.value;
  }
  clear() {
    this.#head = void 0;
    this.#tail = void 0;
    this.#size = 0;
  }
  get size() {
    return this.#size;
  }
  *[Symbol.iterator]() {
    let current = this.#head;
    while (current) {
      yield current.value;
      current = current.next;
    }
  }
  *drain() {
    while (this.#head) {
      yield this.dequeue();
    }
  }
};

// node_modules/p-limit/index.js
function pLimit(concurrency) {
  validateConcurrency(concurrency);
  const queue = new Queue();
  let activeCount = 0;
  const resumeNext = () => {
    if (activeCount < concurrency && queue.size > 0) {
      queue.dequeue()();
      activeCount++;
    }
  };
  const next = () => {
    activeCount--;
    resumeNext();
  };
  const run = async (function_, resolve2, arguments_) => {
    const result = (async () => function_(...arguments_))();
    resolve2(result);
    try {
      await result;
    } catch {
    }
    next();
  };
  const enqueue = (function_, resolve2, arguments_) => {
    new Promise((internalResolve) => {
      queue.enqueue(internalResolve);
    }).then(
      run.bind(void 0, function_, resolve2, arguments_)
    );
    (async () => {
      await Promise.resolve();
      if (activeCount < concurrency) {
        resumeNext();
      }
    })();
  };
  const generator = (function_, ...arguments_) => new Promise((resolve2) => {
    enqueue(function_, resolve2, arguments_);
  });
  Object.defineProperties(generator, {
    activeCount: {
      get: () => activeCount
    },
    pendingCount: {
      get: () => queue.size
    },
    clearQueue: {
      value() {
        queue.clear();
      }
    },
    concurrency: {
      get: () => concurrency,
      set(newConcurrency) {
        validateConcurrency(newConcurrency);
        concurrency = newConcurrency;
        queueMicrotask(() => {
          while (activeCount < concurrency && queue.size > 0) {
            resumeNext();
          }
        });
      }
    }
  });
  return generator;
}
function validateConcurrency(concurrency) {
  if (!((Number.isInteger(concurrency) || concurrency === Number.POSITIVE_INFINITY) && concurrency > 0)) {
    throw new TypeError("Expected `concurrency` to be a number from 1 and up");
  }
}

// src/detection/polyglot-analyzer.ts
var DEFAULT_WORKER_POOL_SIZE = 10;
var MAX_FILE_SIZE = 5 * 1024 * 1024;
var PolyglotAnalyzer = class {
  registry;
  logger;
  constructor(registry, logger) {
    this.registry = registry;
    this.logger = logger;
  }
  /** Analyzes multiple files using appropriate language detectors. */
  async analyzeFiles(files, signal) {
    return this.analyzeFilesWithProgress(files, void 0, signal);
  }
  /** Analyzes multiple files with progress reporting. */
  async analyzeFilesWithProgress(files, progressCallback, signal) {
    const result = {
      files: /* @__PURE__ */ new Map(),
      totalFlags: /* @__PURE__ */ new Map(),
      languages: /* @__PURE__ */ new Map(),
      skippedFiles: [],
      partialFiles: []
    };
    const workerPoolSize = Number(process.env.ANALYZER_WORKER_POOL_SIZE) || DEFAULT_WORKER_POOL_SIZE;
    const limit = pLimit(workerPoolSize);
    this.logger.debug("Using analyzer worker pool size", {
      workerPoolSize,
      filesToAnalyze: files.size
    });
    let filesAnalyzed = 0;
    let filesWithFlags = 0;
    let totalFlagsFound = 0;
    let errorCount = 0;
    let lastEmittedPercent = 0;
    const totalFiles = files.size;
    const tasks = [];
    for (const [filePath, content] of files) {
      if (signal?.aborted) {
        break;
      }
      tasks.push(
        limit(async () => {
          if (signal?.aborted) {
            return;
          }
          const fileResult = await this.analyzeFile(filePath, content);
          filesAnalyzed++;
          result.files.set(filePath, fileResult);
          let flagsInFile = 0;
          for (const flag of fileResult.flags) {
            flag.language = fileResult.language;
            const existing = result.totalFlags.get(flag.name) ?? [];
            existing.push(flag);
            result.totalFlags.set(flag.name, existing);
            flagsInFile++;
            totalFlagsFound++;
          }
          if (flagsInFile > 0) {
            filesWithFlags++;
          }
          if (fileResult.parseErrors.length > 0) {
            errorCount++;
          }
          if (fileResult.status === "skipped") {
            result.skippedFiles.push(filePath);
          } else if (fileResult.status === "partial") {
            result.partialFiles.push(filePath);
          }
          if (fileResult.language) {
            const count = result.languages.get(fileResult.language) ?? 0;
            result.languages.set(fileResult.language, count + 1);
          }
          if (progressCallback && totalFiles > 0) {
            const currentPercent = Math.floor(filesAnalyzed * 100 / totalFiles);
            const roundedPercent = Math.floor(currentPercent / 5) * 5;
            if (roundedPercent > lastEmittedPercent || filesAnalyzed === totalFiles) {
              lastEmittedPercent = roundedPercent;
              progressCallback(filesAnalyzed, totalFiles);
            }
          }
        })
      );
    }
    await Promise.allSettled(tasks);
    if (totalFlagsFound > 0 || errorCount > 0) {
      this.logger.info("Polyglot analysis completed", {
        totalFiles: filesAnalyzed,
        filesWithFlags,
        totalFlagsFound,
        uniqueFlags: result.totalFlags.size,
        filesWithErrors: errorCount,
        languages: Object.fromEntries(result.languages)
      });
    }
    return result;
  }
  /** Analyzes a single file using the appropriate language detector. */
  async analyzeSingleFile(filePath, content) {
    return this.analyzeFile(filePath, content);
  }
  /** Determines if a file should be analyzed based on language support. */
  shouldAnalyzeFile(filePath, status) {
    if (status === "removed") {
      return false;
    }
    if (filePath.includes("/vendor/") || filePath.startsWith("vendor/")) {
      return false;
    }
    if (filePath.includes("/node_modules/") || filePath.startsWith("node_modules/")) {
      return false;
    }
    return !!this.registry.getDetectorForFile(filePath);
  }
  /** Returns all supported file extensions. */
  getSupportedExtensions() {
    return this.registry.getSupportedExtensions();
  }
  async analyzeFile(filePath, content) {
    const result = {
      filePath,
      language: "",
      flags: [],
      parseErrors: [],
      status: "ok"
    };
    if (!filePath) {
      result.parseErrors.push(new Error("empty file path"));
      result.status = "skipped";
      result.skippedReason = "empty file path";
      return result;
    }
    if (content.length === 0) {
      return result;
    }
    if (content.length > MAX_FILE_SIZE) {
      result.parseErrors.push(new Error(`file too large: ${content.length} bytes`));
      result.status = "skipped";
      result.skippedReason = `file too large (${Math.floor(content.length / (1024 * 1024))} MB)`;
      return result;
    }
    const detector = this.registry.getDetectorForFile(filePath);
    if (!detector) {
      result.status = "unsupported";
      return result;
    }
    result.language = detector.language();
    try {
      const flags = await Promise.resolve(detector.detectFlags(filePath, content));
      result.flags = flags;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      result.parseErrors.push(error);
      if (error.message.includes("operation limit")) {
        result.status = "skipped";
        result.skippedReason = "file too complex for parsing";
      } else {
        result.status = "partial";
      }
    }
    return result;
  }
};

// src/detection/yaml-config.ts
import { z } from "zod";
var SupportedLanguageSchema = z.enum([
  "go",
  "typescript",
  "javascript",
  "python",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "csharp",
  "php",
  "rust",
  "cpp",
  "objc",
  "all"
]);
var ValidReturnTypes = ["boolean", "string", "integer", "float", "json"];
var MethodConfigSchema = z.object({
  name: z.string().min(1, "name is required"),
  flag_key_index: z.number().int().min(-1).default(0),
  context_index: z.number().int().optional().default(0),
  min_params: z.number().int().nonnegative().optional().default(0),
  examples: z.array(z.string()).optional().default([]),
  return_type: z.enum(["", ...ValidReturnTypes]).optional().default(""),
  default_value_index: z.number().int().nonnegative().optional().default(0)
});
var FeatureFlagProviderSchema = z.object({
  name: z.string().min(1, "name is required"),
  languages: z.array(SupportedLanguageSchema).optional().default([]),
  import_pattern: z.string().default(""),
  methods: z.array(MethodConfigSchema).min(1, "at least one method must be configured"),
  import_aliases: z.array(z.string()).optional().default([]),
  description: z.string().optional().default(""),
  enabled: z.boolean().default(true)
});
var GlobalConfigSchema = z.object({
  enable_fallback_detection: z.boolean().default(false),
  strict_import_matching: z.boolean().default(false),
  custom_patterns: z.array(z.string()).optional().default([])
});
var FeatureFlagConfigSchema = z.object({
  version: z.string().min(1, "version is required"),
  providers: z.array(FeatureFlagProviderSchema).min(1, "at least one provider must be configured"),
  global_settings: GlobalConfigSchema.optional().default({
    enable_fallback_detection: false,
    strict_import_matching: false,
    custom_patterns: []
  })
});

// src/detection/index.ts
function createDefaultRegistry() {
  const registry = new LanguageRegistry();
  registry.register(new GoDetector());
  registry.register(new TypeScriptDetector());
  registry.register(new PythonDetector());
  registry.register(new JavaDetector());
  registry.register(new KotlinDetector());
  registry.register(new SwiftDetector());
  registry.register(new RubyDetector());
  registry.register(new CSharpDetector());
  registry.register(new PHPDetector());
  registry.register(new RustDetector());
  registry.register(new CPPDetector());
  registry.register(new ObjectiveCDetector());
  registry.register(new JavaScriptDetector());
  return registry;
}

// src/formatter.ts
var VERSION = "1.0.0";
function pad(str, width) {
  if (str.length > width) {
    return str.slice(0, width - 1) + "\u2026";
  }
  return str.padEnd(width);
}
function buildTable(flags) {
  const cols = {
    flag: 16,
    file: 22,
    added: 13,
    signal: 28
  };
  const hBorder = (left, mid, right) => `${left}${"\u2500".repeat(cols.flag + 2)}${mid}${"\u2500".repeat(cols.file + 2)}${mid}${"\u2500".repeat(cols.added + 2)}${mid}${"\u2500".repeat(cols.signal + 2)}${right}`;
  const lines = [];
  lines.push(hBorder("\u250C", "\u252C", "\u2510"));
  lines.push(
    `\u2502 ${pad("Flag", cols.flag)} \u2502 ${pad("File", cols.file)} \u2502 ${pad("Added", cols.added)} \u2502 ${pad("Signal", cols.signal)} \u2502`
  );
  lines.push(hBorder("\u251C", "\u253C", "\u2524"));
  for (const sf of flags) {
    const fileRef = `${sf.filePath}:${sf.lineNumber}`;
    const signalText = sf.signals.map((s) => {
      if (s.type === "age") {
        return "Age > threshold";
      }
      if (s.type === "low-usage") {
        return "Single file";
      }
      return s.description;
    }).join(", ");
    lines.push(
      `\u2502 ${pad(sf.name, cols.flag)} \u2502 ${pad(fileRef, cols.file)} \u2502 ${pad(sf.age ?? "unknown", cols.added)} \u2502 ${pad(signalText, cols.signal)} \u2502`
    );
  }
  lines.push(hBorder("\u2514", "\u2534", "\u2518"));
  return lines.join("\n");
}
function formatText(result, options) {
  const lines = [];
  lines.push(`\u{1F988} FlagShark v${VERSION}`);
  lines.push("");
  const langCount = result.languageBreakdown.size;
  const fileCount = Array.from(result.languageBreakdown.values()).reduce((sum, n) => sum + n, 0);
  lines.push(`Scanned ${fileCount} files across ${langCount} language${langCount === 1 ? "" : "s"}`);
  if (result.totalFlags === 0) {
    lines.push("No feature flags detected.");
    lines.push("");
    lines.push("Supported providers: LaunchDarkly, Unleash, Flipt, Split.io, PostHog, and more.");
    lines.push("Run flagshark scan --help for configuration options.");
    return lines.join("\n");
  }
  if (result.detectedProviders.length > 0) {
    lines.push(`Detected providers: ${result.detectedProviders.join(", ")}`);
  }
  const uniqueStaleNames = new Set(result.staleFlags.map((f) => f.name));
  const staleCount = uniqueStaleNames.size;
  lines.push(`Found ${result.totalFlags} feature flags, ${staleCount} stale`);
  if (staleCount > 0) {
    lines.push("");
    lines.push("Stale flags:");
    const displayCount = options.verbose ? staleCount : Math.min(staleCount, options.maxDisplay);
    const displayFlags = result.staleFlags.slice(0, displayCount);
    lines.push(buildTable(displayFlags));
    const remaining = staleCount - displayCount;
    if (remaining > 0) {
      lines.push("");
      lines.push(`... and ${remaining} more (use --verbose to see all)`);
    }
  }
  lines.push("");
  if (staleCount === 0) {
    lines.push(`Flag Health Score: ${result.healthScore}/100 \u2713 All flags look healthy!`);
  } else {
    lines.push(
      `Flag Health Score: ${result.healthScore}/100 (${staleCount}/${result.totalFlags} flags are stale)`
    );
    lines.push("");
    lines.push("Automate cleanup \u2192 https://flagshark.com");
    lines.push("Open source CLI  \u2192 https://github.com/FlagShark/flagshark");
  }
  return lines.join("\n");
}
function formatJson(result) {
  const languages = {};
  for (const [lang, count] of result.languageBreakdown) {
    languages[lang] = count;
  }
  const flags = result.staleFlags.map((sf) => ({
    name: sf.name,
    file: sf.filePath,
    line: sf.lineNumber,
    language: sf.language,
    provider: sf.provider,
    stale: true,
    signals: sf.signals.map((s) => ({
      type: s.type,
      description: s.description
    })),
    age: sf.age ?? null
  }));
  const output = {
    version: VERSION,
    totalFlags: result.totalFlags,
    staleFlags: new Set(result.staleFlags.map((f) => f.name)).size,
    healthScore: result.healthScore,
    detectedProviders: result.detectedProviders,
    languages,
    flags,
    scanDuration: result.scanDuration,
    links: {
      dashboard: "https://flagshark.com",
      cli: "https://github.com/FlagShark/flagshark",
      npm: "https://www.npmjs.com/package/flagshark"
    }
  };
  return JSON.stringify(output, null, 2);
}

// src/staleness.ts
import { execFileSync, execSync } from "child_process";
function isShallowRepo(repoRoot) {
  try {
    const out = execSync("git rev-parse --is-shallow-repository", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}
function parseBlamePortcelain(output) {
  const lineAges = /* @__PURE__ */ new Map();
  const lines = output.split("\n");
  let currentLine = 0;
  let currentAuthorTime = 0;
  for (const line of lines) {
    const headerMatch = line.match(/^[0-9a-f]{40}\s+\d+\s+(\d+)(?:\s+\d+)?$/);
    if (headerMatch) {
      currentLine = parseInt(headerMatch[1], 10);
      continue;
    }
    if (line.startsWith("author-time ")) {
      currentAuthorTime = parseInt(line.slice("author-time ".length), 10);
      continue;
    }
    if (line.startsWith("	")) {
      if (currentLine > 0 && currentAuthorTime > 0) {
        lineAges.set(currentLine, currentAuthorTime);
      }
    }
  }
  return lineAges;
}
function blameFile(filePath, repoRoot) {
  try {
    const out = execFileSync("git", ["blame", "--porcelain", "--", filePath], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024
      // 10 MB – large files
    });
    return parseBlamePortcelain(out);
  } catch {
    return null;
  }
}
function formatAge(unixSeconds) {
  const nowMs = Date.now();
  const thenMs = unixSeconds * 1e3;
  const diffMs = nowMs - thenMs;
  const seconds = Math.floor(diffMs / 1e3);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30.44);
  const years = Math.floor(days / 365.25);
  if (years >= 1) {
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }
  if (months >= 1) {
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  if (days >= 1) {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return "less than a day ago";
}
function checkAgeSignal(authorTime, thresholdMonths) {
  if (authorTime === void 0) {
    return null;
  }
  const thresholdMs = thresholdMonths * 30.44 * 24 * 60 * 60 * 1e3;
  const ageMs = Date.now() - authorTime * 1e3;
  if (ageMs < thresholdMs) {
    return null;
  }
  const age = formatAge(authorTime);
  return {
    signal: {
      type: "age",
      description: `Flag reference last modified ${age} (threshold: ${thresholdMonths} months)`
    },
    age
  };
}
function checkLowUsageSignal(flagName, occurrences) {
  const uniqueFiles = new Set(occurrences.map((o) => o.filePath));
  if (uniqueFiles.size > 1) {
    return null;
  }
  return {
    type: "low-usage",
    description: `Flag "${flagName}" only appears in 1 file \u2014 may have been fully rolled out`
  };
}
function checkHardcodedSignal(_flag) {
  return null;
}
async function analyzeStaleness(flags, options) {
  const { thresholdMonths = 6, repoRoot } = options;
  const shallow = isShallowRepo(repoRoot);
  const fileBlames = /* @__PURE__ */ new Map();
  if (!shallow) {
    const filesToBlame = /* @__PURE__ */ new Set();
    for (const occurrences of flags.values()) {
      for (const flag of occurrences) {
        filesToBlame.add(flag.filePath);
      }
    }
    for (const file of filesToBlame) {
      fileBlames.set(file, blameFile(file, repoRoot));
    }
  }
  const staleFlags = [];
  for (const [flagName, occurrences] of flags) {
    const lowUsageSignal = checkLowUsageSignal(flagName, occurrences);
    for (const flag of occurrences) {
      const signals = [];
      let age;
      if (!shallow) {
        const blame = fileBlames.get(flag.filePath);
        const authorTime = blame?.get(flag.lineNumber);
        const ageResult = checkAgeSignal(authorTime, thresholdMonths);
        if (ageResult) {
          signals.push(ageResult.signal);
          age = ageResult.age;
        } else if (authorTime !== void 0) {
          age = formatAge(authorTime);
        }
      }
      if (lowUsageSignal) {
        signals.push(lowUsageSignal);
      }
      const hardcoded = checkHardcodedSignal(flag);
      if (hardcoded) {
        signals.push(hardcoded);
      }
      if (signals.length > 0) {
        staleFlags.push({
          name: flag.name,
          filePath: flag.filePath,
          lineNumber: flag.lineNumber,
          language: flag.language,
          provider: flag.provider ?? "unknown",
          signals,
          age
        });
      }
    }
  }
  return staleFlags;
}

// src/cli.ts
var VERSION2 = "1.0.0";
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "vendor",
  ".git",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".next",
  ".turbo"
]);
var MAX_FILE_SIZE2 = 5 * 1024 * 1024;
var HELP_TEXT = `
flagshark scan [options]

Options:
  --json            Output as JSON
  --diff <ref>      Only scan files changed since <ref> (e.g., HEAD~1, main)
  --threshold <n>   Staleness threshold in months (default: 6)
  --verbose         Show all stale flags (not just top 10)
  --help            Show help
  --version         Show version
`.trim();
function parseArgs(argv) {
  const args = {
    json: false,
    diff: null,
    threshold: 6,
    verbose: false,
    help: false,
    version: false
  };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--diff":
        i++;
        args.diff = argv[i] ?? null;
        if (!args.diff) {
          throw new Error("--diff requires a git ref argument (e.g., HEAD~1, main)");
        }
        break;
      case "--threshold":
        i++;
        args.threshold = parseInt(argv[i], 10);
        if (isNaN(args.threshold) || args.threshold < 1) {
          throw new Error("--threshold requires a positive integer (months)");
        }
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "scan":
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
    i++;
  }
  return args;
}
function createLogger(verbose) {
  return {
    debug: (...args) => {
      if (verbose) {
        console.error("[debug]", ...args);
      }
    },
    info: (...args) => console.error("[info]", ...args),
    warn: (...args) => console.error("[warn]", ...args),
    error: (...args) => console.error("[error]", ...args)
  };
}
function walkDirectory(dir, supportedExtensions, logger) {
  const files = [];
  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      logger.warn(`Cannot read directory: ${currentDir}`);
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name);
      if (!supportedExtensions.has(ext)) {
        continue;
      }
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE2) {
          logger.debug(`Skipping large file: ${fullPath} (${stat.size} bytes)`);
          continue;
        }
      } catch {
        continue;
      }
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        files.push({ path: fullPath, content });
      } catch {
        logger.debug(`Cannot read file: ${fullPath}`);
      }
    }
  }
  walk(dir);
  return files;
}
function getDiffFiles(ref, cwd, supportedExtensions, logger) {
  let output;
  try {
    output = execFileSync2("git", ["diff", ref, "--name-only"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch (err) {
    throw new Error(
      `Failed to get diff against "${ref}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!output) {
    return [];
  }
  const files = [];
  for (const relPath of output.split("\n")) {
    const ext = path.extname(relPath);
    if (!supportedExtensions.has(ext)) {
      continue;
    }
    const fullPath = path.resolve(cwd, relPath);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE2) {
        logger.debug(`Skipping large file: ${fullPath}`);
        continue;
      }
      const content = fs.readFileSync(fullPath, "utf-8");
      files.push({ path: fullPath, content });
    } catch {
      logger.debug(`Cannot read changed file: ${fullPath}`);
    }
  }
  return files;
}
async function main() {
  const args = parseArgs(process.argv);
  if (args.version) {
    process.stdout.write(`flagshark v${VERSION2}
`);
    process.exit(0);
  }
  if (args.help) {
    process.stdout.write(HELP_TEXT + "\n");
    process.exit(0);
  }
  const verbose = args.verbose;
  const logger = createLogger(verbose);
  const startTime = performance.now();
  const cwd = process.cwd();
  logger.debug("Creating language registry...");
  const registry = createDefaultRegistry();
  const analyzer = new PolyglotAnalyzer(registry, logger);
  const supportedExtensions = new Set(registry.getSupportedExtensions());
  logger.debug("Collecting files...");
  let fileEntries;
  if (args.diff) {
    logger.info(`Scanning files changed since ${args.diff}...`);
    fileEntries = getDiffFiles(args.diff, cwd, supportedExtensions, logger);
  } else {
    logger.info("Scanning current directory...");
    fileEntries = walkDirectory(cwd, supportedExtensions, logger);
  }
  logger.debug(`Found ${fileEntries.length} files to scan`);
  const fileMap = /* @__PURE__ */ new Map();
  for (const entry of fileEntries) {
    fileMap.set(entry.path, entry.content);
  }
  logger.debug("Running detection...");
  const analysisResult = await analyzer.analyzeFiles(fileMap);
  logger.debug("Analyzing staleness...");
  const staleFlags = await analyzeStaleness(
    analysisResult.totalFlags,
    {
      thresholdMonths: args.threshold,
      repoRoot: cwd
    }
  );
  const totalFlags = analysisResult.totalFlags.size;
  const uniqueStaleNames = new Set(staleFlags.map((f) => f.name)).size;
  const healthScore = totalFlags === 0 ? 100 : Math.round((totalFlags - uniqueStaleNames) / totalFlags * 100);
  const allFlags = [];
  for (const flags of analysisResult.totalFlags.values()) {
    allFlags.push(...flags);
  }
  const detectedProviders = [
    ...new Set(
      allFlags.map((f) => f.provider).filter((p) => p !== null && p !== void 0 && p !== "")
    )
  ];
  const languageBreakdown = analysisResult.languages;
  const scanDuration = Math.round(performance.now() - startTime);
  const result = {
    totalFlags,
    staleFlags,
    detectedProviders,
    languageBreakdown,
    healthScore,
    scanDuration
  };
  const output = args.json ? formatJson(result) + "\n" : formatText(result, { json: false, verbose: args.verbose, maxDisplay: 10 }) + "\n";
  const exitCode = staleFlags.length > 0 ? 1 : 0;
  if (process.stdout.write(output)) {
    process.exit(exitCode);
  } else {
    process.stdout.once("drain", () => process.exit(exitCode));
  }
}
main().catch((err) => {
  console.error(`[error] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
