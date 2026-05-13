class Plain
  def enabled?
    variation("not-detected-without-import", nil, false)
  end

  def variation(key, ctx, default)
    default
  end
end
