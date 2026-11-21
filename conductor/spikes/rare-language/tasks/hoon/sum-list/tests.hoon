::  Tests for sum-list. The check script installs the attempt as /lib/task.hoon.
/+  *test, *task
|%
++  test-sum-list
  ;:  weld
    (expect-eq !>(`@ud`6) !>((sum-list ~[1 2 3])))
    (expect-eq !>(`@ud`0) !>((sum-list ~)))
  ==
--
