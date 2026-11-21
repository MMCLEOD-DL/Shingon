|%
++  count-evens
  |=  l=(list @ud)
  ^-  @ud
  (lent (skim l |=(n=@ud =(1 (mod n 2)))))
--
