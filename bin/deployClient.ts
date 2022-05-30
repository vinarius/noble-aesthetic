import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { lookup } from 'mime-types';
import { getAppConfig } from '../lib/getAppConfig';
import { resolveFromRoot } from '../lib/resolveFromRoot';
import { retryOptions } from '../lib/retryOptions';
import { validateAwsProfile } from '../lib/validateAwsProfile';

const S3SyncClient = require('s3-sync-client');

const cloudfrontClient = new CloudFrontClient({ ...retryOptions });
const s3Client = new S3Client({ ...retryOptions });
const { sync } = new S3SyncClient({ client: s3Client });

async function syncHostBucket() {
  const { IS_CODEBUILD } = process.env;

  try {
    const { profile, project, stage, env, isStagingEnv } = await getAppConfig();

    if (!IS_CODEBUILD) {
      await validateAwsProfile(profile);
      process.env.AWS_PROFILE = profile;
      process.env.AWS_REGION = env.region;
    }

    const outputsPath = resolveFromRoot(isStagingEnv ? `cdk-outputs-${stage}.json` : 'dist', `cdk-outputs-${stage}.json`);
    const cdkOutputsRaw = JSON.parse(readFileSync(outputsPath).toString());
    const hostBucketName = cdkOutputsRaw[`${project}-host-stack-${stage}`][`${project}hostBucketNameOutput${stage.replace(/\W/g, '')}`];
    const distributionId = cdkOutputsRaw[`${project}-host-stack-${stage}`][`${project}siteDistributionIdOutput${stage.replace(/\W/g, '')}`];

    await sync(resolveFromRoot('dist', 'client'), `s3://${hostBucketName}`, {
      del: true,
      commandInput: {
        ContentType: (syncCommandInput: { Key: string; }) => (
          lookup(syncCommandInput.Key) || 'text/html'
        )
      }
    });

    await cloudfrontClient.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: new Date().toISOString(),
        Paths: {
          Items: ['/*'],
          Quantity: 1
        }
      }
    }));

    console.log('\n>>> Client deployment complete.\n');
  } catch (error) {
    const { name, message } = error as Error;
    console.error(`${name}: ${message}`);
    console.error(error);

    process.exit(1);
  }
}

syncHostBucket();