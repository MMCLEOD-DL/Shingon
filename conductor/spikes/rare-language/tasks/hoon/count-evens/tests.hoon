::  Tests for count-evens. The check script installs the attempt as /lib/task.hoon.
/+  *test, *task
|%
++  test-count-evens
  ;:  weld
    (expect-eq !>(`@ud`2) !>((count-evens ~[1 2 3 4])))
    (expect-eq !>(`@ud`0) !>((count-evens ~)))
    (expect-eq !>(`@ud`1) !>((count-evens ~[0])))
  ==
--
