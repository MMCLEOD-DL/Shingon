|%
++  count-evens
  |=  l=(list @ud)
  ^-  @ud
  (lent (skim l |=(n=@ud =(0 (mod n 2)))))
--
