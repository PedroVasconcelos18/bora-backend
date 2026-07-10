import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { ChallengesModule } from './challenges/challenges.module';
import { InvitesModule } from './invites/invites.module';
import { EmailModule } from './email/email.module';
import { PaymentsModule } from './payments/payments.module';
import { ParticipantsModule } from './participants/participants.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AdminModule } from './admin/admin.module';
import { StorageModule } from './storage/storage.module';
import { EvidencesModule } from './evidences/evidences.module';
import { VotingModule } from './voting/voting.module';
import { RankingModule } from './ranking/ranking.module';
import { ProfileModule } from './profile/profile.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    AuthModule,
    EmailModule,
    InvitesModule,
    ChallengesModule,
    PaymentsModule,
    ParticipantsModule,
    SchedulerModule,
    AdminModule,
    StorageModule,
    EvidencesModule,
    VotingModule,
    RankingModule,
    ProfileModule,
  ],
})
export class AppModule {}
