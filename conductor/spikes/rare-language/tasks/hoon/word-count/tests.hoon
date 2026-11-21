::  Tests for word-count. The check script installs the attempt as /lib/task.hoon.
/+  *test, *task
|%
++  test-word-count
  =/  m  (word-count ~['a' 'b' 'a'])
  ;:  weld
    (expect-eq !>(`@ud`2) !>((~(gut by m) 'a' 0)))
    (expect-eq !>(`@ud`1) !>((~(gut by m) 'b' 0)))
    (expect-eq !>(`@ud`0) !>((~(gut by m) 'c' 0)))
  ==
--
