::  Tests for add-two. The check script installs the attempt as /lib/task.hoon.
/+  *test, *task
|%
++  test-add-two
  ;:  weld
    (expect-eq !>(`@ud`5) !>((add-two 3)))
    (expect-eq !>(`@ud`2) !>((add-two 0)))
  ==
--
