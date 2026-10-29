/** The part of pdfkit 0.20.2's API this module uses (the package ships no TypeScript types). */
declare module 'pdfkit' {
  interface PDFDocumentOptions {
    size?: string;
    margin?: number;
    bufferPages?: boolean;
    info?: { CreationDate?: Date; Producer?: string; Creator?: string };
  }
  interface TextOptions {
    lineBreak?: boolean;
  }
  class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    font(name: 'Helvetica' | 'Helvetica-Bold'): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    strokeColor(color: string): this;
    lineWidth(width: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    text(text: string, x: number, y: number, options?: TextOptions): this;
    widthOfString(text: string): number;
    addPage(): this;
    switchToPage(index: number): this;
    bufferedPageRange(): { start: number; count: number };
    end(): void;
  }
  export default PDFDocument;
}
