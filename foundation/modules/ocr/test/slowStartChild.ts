// A reader process that starts slowly, for the tests of the start-up allowance (pdfText.ts's `childFile` option):
// it waits 3.5 s, longer than the 3 s read limit, before loading the real reader, which then works as usual.
await new Promise((resolve) => setTimeout(resolve, 3_500));
await import(new URL('../src/pdfChild.ts', import.meta.url).href);
