import { Module } from '@nestjs/common';
import { ChallengesController } from './challenges.controller';
import { ChallengesService } from './challenges.service';
import { InvitesModule } from '../invites/invites.module';
import { PaymentsModule } from '../payments/payments.module';
import { ParticipantsModule } from '../participants/participants.module';

/**
 * Imports PaymentsModule so ChallengesService can delegate creator
 * cancellation (D-09) to PaymentsService.cancelChallenge (D-10/D-12), and
 * ParticipantsModule so ChallengesController can expose the waiting-room
 * nominal list (CHAL-05, D-13) via ParticipantsService.getWaitingRoomStatus.
 */
@Module({
  imports: [InvitesModule, PaymentsModule, ParticipantsModule],
  controllers: [ChallengesController],
  providers: [ChallengesService],
  exports: [ChallengesService],
})
export class ChallengesModule {}
