import { Module } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
