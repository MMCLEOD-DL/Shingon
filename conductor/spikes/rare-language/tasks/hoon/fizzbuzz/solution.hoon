|%
++  fizzbuzz
  |=  n=@ud
  ^-  tape
  ?:  =(0 (mod n 15))  "FizzBuzz"
  ?:  =(0 (mod n 3))  "Fizz"
  ?:  =(0 (mod n 5))  "Buzz"
  (scow %ud n)
--
