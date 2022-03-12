import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent } from 'aws-lambda';

import { adminResetUserPassword } from '../../lib/cognito';
import { setDefaultProps } from '../../lib/lambda';
import { retryOptions } from '../../lib/retryOptions';
import { validateEnvVars } from '../../lib/validateEnvVars';
import { HandlerResponse } from '../../models/response';
import { AdminResetUserPasswordReqBody, validateAdminResetPassword } from '../../models/user';

const {
  userPoolId = '',
  usersTableName = ''
} = process.env;

const cognitoClient = new CognitoIdentityProviderClient({ ...retryOptions });
const dynamoClient = new DynamoDBClient({ ...retryOptions });
const docClient = DynamoDBDocument.from(dynamoClient);

const adminResetPasswordHandler = async (event: APIGatewayProxyEvent): Promise<HandlerResponse> => {
  validateEnvVars(['userPoolId', 'usersTableName']);

  const partitionKey = 'userName';
  const sortKey = 'data';
  const userParams: AdminResetUserPasswordReqBody = JSON.parse(event.body ?? '{}');

  const isValid = validateAdminResetPassword(userParams);
  if (!isValid) throw {
    success: false,
    validationErrors: validateAdminResetPassword.errors ?? [],
    statusCode: 400
  };

  const { userName } = userParams.input;

  const itemQuery = await docClient.query({
    TableName: usersTableName,
    KeyConditionExpression: `${partitionKey} = :${partitionKey} and ${sortKey} = :${sortKey}`,
    ExpressionAttributeValues: {
      [`:${partitionKey}`]: userName,
      [`:${sortKey}`]: 'details'
    }
  });

  if (itemQuery.Count === 0) throw {
    success: false,
    error: `Username '${userName}' not found`,
    statusCode: 404
  };

  await adminResetUserPassword(cognitoClient, userPoolId, userName);

  return {
    success: true
  };
};

export async function handler(event: APIGatewayProxyEvent) {
  console.log('Event:', JSON.stringify(event));

  const response = await setDefaultProps(event, adminResetPasswordHandler);

  console.log('Response:', response);
  return response;
}