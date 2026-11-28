import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';

import { INTAKE_PICK_SCHEMA, INTAKE_PICK_SYSTEM, IntakePickError, pickPrompt, pickRequestFrom, picksFrom, type IntakePick, type PickRequest } from './intake-pick';
import { AiBudgetService, type AiCaller } from '../../common/ai/ai-budget.service';

/** A pick is a short choice from a list, made while the person waits at a question: the model the page's answers come from. */
export const INTAKE_PICK_MODEL = 'claude-sonnet-5-5';

export interface IntakePicks { picks: IntakePick[]; model: string }

/**
 * Picks from a list for the intake page (a likely material, or the answer the person's words mean), through AiBudgetService like
 * every other AI call: the caller's budget pays for it. Nothing is saved and nothing is created; no picks is a valid answer.
 */
@Injectable()
export class IntakePicksService {
  constructor(private readonly ai: AiBudgetService) {}

  async pick(raw: unknown, caller: AiCaller): Promise<IntakePicks> {
    let request: PickRequest;
    try {
      request = pickRequestFrom(raw);          // refused here, before any AI is spent
    } catch (error) {
      if (error instanceof IntakePickError) throw new BadRequestException({ code: 'bad_pick_request', message: error.message });
      throw error;
    }

    const session = await this.ai.open(caller, 'drawing_pick');
    try {
      const message = await session.create({
        model: INTAKE_PICK_MODEL,
        system: INTAKE_PICK_SYSTEM[request.purpose],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: INTAKE_PICK_SCHEMA } },
        messages: [{ role: 'user', content: pickPrompt(request) }],
      }, { timeout: 60_000, maxRetries: 1 });
      if (message.stop_reason === 'refusal') throw new BadGatewayException('The AI service declined to pick.');
      if (message.stop_reason === 'max_tokens') throw new BadGatewayException('The AI service did not finish its pick.');
      const answer = message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
      try {
        return { picks: picksFrom(JSON.parse(answer), request), model: INTAKE_PICK_MODEL };
      } catch (error) {
        if (error instanceof SyntaxError) throw new BadGatewayException('The AI service did not return a pick.');
        throw error;
      }
    } finally {
      session.close();
    }
  }
}
