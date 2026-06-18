; Java unifies receiver calls and bare calls under method_invocation, so a
; single pattern covers both client.boolVariation("flag", ...) and a bare
; boolVariation("flag", ...). The `object:` field is left unconstrained so
; both shapes match; the engine filters by method name.
(method_invocation
  name: (identifier) @method
  arguments: (argument_list) @args) @call
