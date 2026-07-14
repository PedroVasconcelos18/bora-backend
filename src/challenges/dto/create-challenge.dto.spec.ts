/**
 * create-challenge.dto.spec.ts — validation-only spec for CreateChallengeDto.
 *
 * Backend is the authority: a POST /challenges direct request (curl, no UI)
 * with out-of-range durationDays/collabAmount/invitees must be rejected by
 * the global ValidationPipe with a 400 and pt-BR message text (not just an
 * error count). Covers min/max boundaries in both directions.
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateChallengeDto } from './create-challenge.dto';

const basePayload = {
  title: 'Corrida matinal',
  emoji: '🏃',
  durationDays: 14,
  collabAmount: 50,
  invitees: ['a@b.com', 'c@d.com'],
};

async function validatePayload(overrides: Record<string, unknown>) {
  const instance = plainToInstance(CreateChallengeDto, { ...basePayload, ...overrides });
  return validate(instance);
}

function flattenMessages(errors: Awaited<ReturnType<typeof validate>>): string[] {
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

async function expectErrorMessage(overrides: Record<string, unknown>, expectedMessage: string) {
  const errors = await validatePayload(overrides);
  const messages = flattenMessages(errors);
  expect(messages).toContain(expectedMessage);
}

describe('CreateChallengeDto — durationDays', () => {
  it('3 dias é válido (piso)', async () => {
    const errors = await validatePayload({ durationDays: 3 });
    expect(errors).toHaveLength(0);
  });

  it('365 dias é válido (teto)', async () => {
    const errors = await validatePayload({ durationDays: 365 });
    expect(errors).toHaveLength(0);
  });

  it('2 dias é rejeitado com mensagem pt-BR de mínimo', async () => {
    await expectErrorMessage({ durationDays: 2 }, 'A duração mínima é de 3 dias.');
  });

  it('366 dias é rejeitado com mensagem pt-BR de máximo', async () => {
    await expectErrorMessage({ durationDays: 366 }, 'A duração máxima é de 365 dias.');
  });

  it('-1 dia é rejeitado com mensagem pt-BR de mínimo', async () => {
    await expectErrorMessage({ durationDays: -1 }, 'A duração mínima é de 3 dias.');
  });
});

describe('CreateChallengeDto — collabAmount', () => {
  it('R$ 5 é válido (piso)', async () => {
    const errors = await validatePayload({ collabAmount: 5 });
    expect(errors).toHaveLength(0);
  });

  it('R$ 200 é válido (teto)', async () => {
    const errors = await validatePayload({ collabAmount: 200 });
    expect(errors).toHaveLength(0);
  });

  it('R$ 4 é rejeitado com mensagem pt-BR de mínimo', async () => {
    await expectErrorMessage({ collabAmount: 4 }, 'A colaboração mínima é R$ 5.');
  });

  it('R$ 201 é rejeitado com mensagem pt-BR de máximo', async () => {
    await expectErrorMessage({ collabAmount: 201 }, 'A colaboração máxima é R$ 200.');
  });

  it('-R$ 50 é rejeitado com mensagem pt-BR de mínimo', async () => {
    await expectErrorMessage({ collabAmount: -50 }, 'A colaboração mínima é R$ 5.');
  });
});

describe('CreateChallengeDto — invitees', () => {
  it('2 e-mails é válido (piso)', async () => {
    const errors = await validatePayload({ invitees: ['a@b.com', 'c@d.com'] });
    expect(errors).toHaveLength(0);
  });

  it('9 e-mails é válido (teto — criador ocupa a 10ª vaga)', async () => {
    const nineEmails = Array.from({ length: 9 }, (_, i) => `friend${i}@x.com`);
    const errors = await validatePayload({ invitees: nineEmails });
    expect(errors).toHaveLength(0);
  });

  it('1 e-mail é rejeitado com mensagem pt-BR de mínimo', async () => {
    await expectErrorMessage(
      { invitees: ['a@b.com'] },
      'Convide pelo menos 2 amigos (mínimo de 3 pessoas).',
    );
  });

  it('10 e-mails é rejeitado com mensagem pt-BR de máximo', async () => {
    const tenEmails = Array.from({ length: 10 }, (_, i) => `friend${i}@x.com`);
    await expectErrorMessage(
      { invitees: tenEmails },
      'O desafio aceita no máximo 10 pessoas — convide até 9 amigos.',
    );
  });
});
