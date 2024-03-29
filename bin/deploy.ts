import { exec, getAppConfig } from '../lib/utils';

export async function deploy(): Promise<void> {
  const { alias, branch, deployMfa } = await getAppConfig();
  const profile: string = deployMfa ? `${alias}-token` : alias;
  console.log();
  console.log(`>>> Synthesizing '${branch}' branch for deployment to ${alias} account`);
  console.log(`>>> Using profile ${profile}`);
  console.log();
  const stackName: string = process.env.STACK || '--all';
  await exec(`npm run cdk -- deploy ${stackName} --require-approval never --profile ${profile}`);
}

deploy().catch(err => {
  console.error(err);
  process.exit(1);
});
