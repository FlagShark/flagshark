; Match method-style calls: <receiver>.<method>(<args>)
(call_expression
  function: (member_expression
    object: (_) @receiver
    property: (property_identifier) @method)
  arguments: (arguments) @args) @call

; Match free-function calls: <method>(<args>)
(call_expression
  function: (identifier) @method
  arguments: (arguments) @args) @call
