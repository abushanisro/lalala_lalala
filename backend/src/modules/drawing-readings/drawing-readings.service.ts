import { BadGatewayException, Injectable, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';

import {
  DRAWING_FILES, DRAWING_READING_SCHEMA, DRAWING_READING_SYSTEM, DrawingReadingError, drawingFileKind, readingFromAi, type DrawingReading,
} from './drawing-reading';
import { AiBudgetService, type AiCaller } from '../../common/ai/ai-budget.service';

import type Anthropic from '@anthropic-ai/sdk';


/** Reading dimensions off a drawing is the step a wrong answer costs most, so it runs on the strongest reader. */
export const DRAWING_READING_MODEL = 'claude-opus-5-5';

export interface DrawingReadingResult { fileName: string; model: string; reading: DrawingReading }

/**
 * Reads one drawing (an image or a PDF) with the vision model, through AiBudgetService like every other AI call: the caller's budget
 * pays for it. Nothing is saved: the answer goes back to the person, who checks it before anything is created from it.
 */
@Injectable()
export class DrawingReadingsService {
  constructor(private readonly ai: AiBudgetService) {}

  async read(file: { buffer: Buffer; originalname: string }, caller: AiCaller, note?: string): Promise<DrawingReadingResult> {
    const kind = drawingFileKind(file.buffer);
    if (!kind) {
      throw new UnsupportedMediaTypeException({ code: 'not_a_drawing_file', message: 'A drawing is a PNG, JPEG, WebP or GIF image, or a PDF.' });
    }
    const { mediaType, maxBytes } = DRAWING_FILES[kind];
    if (file.buffer.length > maxBytes) {
      throw new PayloadTooLargeException({ code: 'drawing_too_large', message: `This ${kind.toUpperCase()} is over the ${maxBytes / (1024 * 1024)} MB a drawing of that kind may be.` });
    }
    const data = file.buffer.toString('base64');
    const drawing: Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam = kind === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType as Exclude<typeof mediaType, 'application/pdf'>, data } };
    const said = note?.trim().slice(0, 500);

    const session = await this.ai.open(caller, 'drawing_extraction');
    try {
      const message = await session.create({
        model: DRAWING_READING_MODEL,
        system: DRAWING_READING_SYSTEM,
        output_config: { effort: 'high', format: { type: 'json_schema', schema: DRAWING_READING_SCHEMA } },
        messages: [{ role: 'user', content: [drawing, { type: 'text', text: said ? `Read this drawing.\nThe person who uploaded it wrote: "${said}"` : 'Read this drawing.' }] }],
      }, { timeout: 180_000, maxRetries: 1 });   // a dense drawing at high effort takes longer than the gateway's one minute
      if (message.stop_reason === 'refusal') throw new BadGatewayException('The AI service declined to read this file.');
      if (message.stop_reason === 'max_tokens') throw new BadGatewayException('This drawing holds more than one reading can take. Send it one sheet at a time.');
      const answer = message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
      try {
        return { fileName: file.originalname, model: DRAWING_READING_MODEL, reading: readingFromAi(JSON.parse(answer)) };
      } catch (error) {
        if (error instanceof DrawingReadingError || error instanceof SyntaxError) throw new BadGatewayException('The AI service did not return a reading of this file.');
        throw error;
      }
    } finally {
      session.close();
    }
  }
}
