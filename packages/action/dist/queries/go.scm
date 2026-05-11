; Method call on a receiver: client.BoolVariation(...)
(call_expression
  function: (selector_expression
    operand: (_) @receiver
    field: (field_identifier) @method)
  arguments: (argument_list) @args) @call

; Bare function call: BoolVariation(...)
(call_expression
  function: (identifier) @method
  arguments: (argument_list) @args) @call
