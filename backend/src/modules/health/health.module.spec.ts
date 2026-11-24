import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AuditModule } from '../../common/audit/audit.module';
import { StorageModule } from '../../common/storage/storage.module';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

// The real module graph: the controller resolves with every indicator it probes. No database is contacted (providers are only constructed).
describe('HealthModule wiring', () => {
  it('resolves the controller from the real module graph', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [
            () => ({
              POSTGREST_URL: 'http://rest.invalid:3000',
              DB_JWT_SECRET: 'j'.repeat(40),
              S3_BUCKET: 'emithran',
              S3_REGION: 'us-east-1',
              S3_ACCESS_KEY_ID: 'key',
              S3_SECRET_ACCESS_KEY: 'secret',
              AUTH0_DOMAIN: 'tenant.example.auth0.com',
              AUTH0_AUDIENCE: 'https://api.example.com',
              AUTH0_CLAIM_NAMESPACE: 'https://example.com/',
            }),
          ],
        }),
        AuditModule, // global in the app
        StorageModule, // global in the app
        HealthModule,
      ],
    }).compile();

    expect(moduleRef.get(HealthController)).toBeDefined();
    await moduleRef.close();
  });
});
