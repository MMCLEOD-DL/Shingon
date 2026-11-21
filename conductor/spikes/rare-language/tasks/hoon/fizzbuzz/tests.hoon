::  Tests for fizzbuzz. The check script installs the attempt as /lib/task.hoon.
/+  *test, *task
|%
++  test-fizzbuzz
  ;:  weld
    (expect-eq !>(`tape`"FizzBuzz") !>((fizzbuzz 15)))
    (expect-eq !>(`tape`"Fizz") !>((fizzbuzz 9)))
    (expect-eq !>(`tape`"Buzz") !>((fizzbuzz 10)))
    (expect-eq !>(`tape`"7") !>((fizzbuzz 7)))
  ==
--
