import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';

import { drawingBlock } from './drawing-readings.service';
import { INTAKE_ANSWER_SYSTEM, IntakeQuestionError, answerFrom, questionFrom } from './intake-answer';
import { AiBudgetService, type AiCaller } from '../../common/ai/ai-budget.service';

/** A question is answered by the model the rest of the app's assistants use; the dimensions a cost is built from are read by the drawing reader. */
export const INTAKE_ANSWER_MODEL = 'claude-sonnet-5-5';

export interface IntakeAnswer { answer: string; model: string; fileName: string | null }

/**
 * Answers one question, about the attached drawing or picture when there is one, through AiBudgetService like every other AI call:
 * the caller's budget pays for it. Nothing is saved and nothing is created.
 */
@Injectable()
export class IntakeAnswersService {
  constructor(private readonly ai: AiBudgetService) {}

  async ask(rawQuestion: unknown, file: { buffer: Buffer; originalname: string } | undefined, caller: AiCaller): Promise<IntakeAnswer> {
    let question: string;
    try {
      question = questionFrom(rawQuestion);
    } catch (error) {
      if (error instanceof IntakeQuestionError) throw new BadRequestException({ code: 'bad_question', message: error.message });
      throw error;
    }
    // Refused here, before any AI is spent, when the file is not a drawing the model can take.
    const drawing = file ? drawingBlock(file.buffer) : null;

    const session = await this.ai.open(caller, 'drawing_question');
    try {
      const message = await session.create({
        model: INTAKE_ANSWER_MODEL,
        system: INTAKE_ANSWER_SYSTEM,
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: drawing ? [drawing, { type: 'text', text: question }] : question }],
      }, { timeout: 120_000, maxRetries: 1 });
      if (message.stop_reason === 'refusal') throw new BadGatewayException('The AI service declined to answer this question.');
      const answer = answerFrom(message.content);
      if (answer === null) throw new BadGatewayException('The AI service did not return an answer. Ask again, or ask a narrower question.');
      return { answer, model: INTAKE_ANSWER_MODEL, fileName: file?.originalname ?? null };
    } finally {
      session.close();
    }
  }
}
