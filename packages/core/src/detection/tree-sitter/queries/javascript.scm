; tree-sitter-javascript's grammar uses identical node names to typescript
; for these call shapes — we duplicate the file for clarity even though the
; content is identical.

(call_expression
  function: (member_expression
    object: (_) @receiver
    property: (property_identifier) @method)
  arguments: (arguments) @args) @call

(call_expression
  function: (identifier) @method
  arguments: (arguments) @args) @call
