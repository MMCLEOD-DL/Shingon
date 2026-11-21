|%
++  word-count
  |=  words=(list @t)
  ^-  (map @t @ud)
  %+  roll  words
  |=  [w=@t acc=(map @t @ud)]
  (~(put by acc) w +((~(gut by acc) w 0)))
--
