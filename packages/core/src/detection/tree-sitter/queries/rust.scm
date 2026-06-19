; Method call on a receiver: client.bool_variation(&ctx, "flag", ...)
(call_expression
  function: (field_expression
    field: (field_identifier) @method)
  arguments: (arguments) @args) @call

; Bare function call: bool_variation("flag", ...)
(call_expression
  function: (identifier) @method
  arguments: (arguments) @args) @call
