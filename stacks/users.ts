import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  LambdaIntegration,
  Resource,
  RestApi
} from 'aws-cdk-lib/aws-apigateway';
import { ClientAttributes, UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction as NodeLambda } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { resolve } from 'path';

import { NobleStackProps } from '../models/cloudResources';
import { HttpMethod } from '../models/enums';
import { LambdaDefinition } from '../models/lambda';

export class UsersStack extends Stack {
  constructor(scope: Construct, id: string, props: NobleStackProps) {
    super(scope, id, props);

    const {
      project,
      stage,
      stack,
      isStagingEnv
    } = props;

    const removalPolicy = isStagingEnv ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    /**
     * Cognito Section
     */
    const userPool = new UserPool(this, `${project}-${stack}-pool-${stage}`, {
      autoVerify: {
        email: true
      },
      signInAliases: {
        email: true
      },
      standardAttributes: {
        email: {
          required: true
        }
      },
      selfSignUpEnabled: stage === 'prod',
      userPoolName: `${project}-${stack}-pool-${stage}`,
      removalPolicy
    });

    // new StringParameter(this, `${project}-${stack}-userpoolArnParam-${stage}`, {
    //   parameterName: `/${project}/${stack}/userPoolArn/${stage}`,
    //   stringValue: userPool.userPoolArn
    // });

    const webAppClient = new UserPoolClient(this, `${project}-webAppClient-${stage}`, {
      userPool,
      userPoolClientName: `${project}-webAppClient-${stage}`,
      authFlows: {
        userPassword: true
      },
      readAttributes: new ClientAttributes().withStandardAttributes({
        email: true,
        emailVerified: true,
        phoneNumber: true
      }),
      accessTokenValidity: Duration.hours(24),
      idTokenValidity: Duration.hours(24),
      supportedIdentityProviders: [
        {
          name: 'COGNITO'
        }
      ],
      writeAttributes: new ClientAttributes().withStandardAttributes({
        email: true,
        phoneNumber: true
      })
    });
    
    webAppClient.applyRemovalPolicy(removalPolicy);

    new CfnOutput(this, `${project}-webClientId-${stage}`, {
      value: webAppClient.userPoolClientId
    });

    /**
     * DynamoDB Section
     */
    const usersTable = new Table(this, `${project}-${stack}-table-${stage}`, {
      partitionKey: {
        name: 'userId',
        type: AttributeType.STRING
      },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy
    });

    usersTable.addGlobalSecondaryIndex({
      indexName: 'email_index',
      partitionKey: {
        name: 'email',
        type: AttributeType.STRING
      }
    });

    /**
     * API Gateway Section
     */
    const apiId = StringParameter.fromStringParameterName(this, `${project}-apiIdParam-${stage}`, `/${project}/api/id/${stage}`).stringValue;
    const rootResourceId = StringParameter.fromStringParameterName(this, `${project}-rootResourceIdParam-${stage}`, `/${project}/api/rootResourceId/${stage}`).stringValue;

    const restApi = RestApi.fromRestApiAttributes(this, `${project}-baseApi-${stage}`, {
      restApiId: apiId,
      rootResourceId
    });

    const apiSpecificRoute = restApi.root.addResource('users'); // api requests map to {domain}/users/...

    const cognitoAuthorizer = new CognitoUserPoolsAuthorizer(this, `${project}-${stack}-authorizer-${stage}`, {
      cognitoUserPools: [ userPool ],
      authorizerName: `${project}-${stack}-authorizer-${stage}`,
      resultsCacheTtl: stage === 'prod' ? Duration.minutes(5) : Duration.minutes(0)
    });

    const authMethodOptions = {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: cognitoAuthorizer
    };

    /**
     * Lambda Section
     */
    // Lambda specific configuration is defined here.
    const lambdaDefinitions: LambdaDefinition[] = [
      {
        name: 'adminCreateUser',
        skip: true,
        api: {
          httpMethod: HttpMethod.PUT,
          customApiPath: 'admin/create',
          isAuthNeeded: true
        },
        environment: {
          userPoolId: userPool.userPoolId,
          usersTableName: usersTable.tableName
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:ListUsers'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ],
        description: 'Create a user as an admin. Does not require a confirmation code.'
      },
      {
        name: 'adminDelete',
        skip: true,
        api: {
          httpMethod: HttpMethod.DELETE,
          customApiPath: 'admin/{userId}',
          isAuthNeeded: true
        },
        environment: {
          userPoolId: userPool.userPoolId,
          usersTableName: usersTable.tableName
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:AdminDeleteUser'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ],
        description: 'Delete a user as an admin. Does not require a confirmation code.'
      },
      {
        name: 'adminResetPassword',
        skip: true,
        api: {
          httpMethod: HttpMethod.POST,
          customApiPath: 'admin/resetPassword',
          isAuthNeeded: true
        },
        environment: {
          userPoolId: userPool.userPoolId,
          usersTableName: usersTable.tableName
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:AdminResetUserPassword'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'changePassword',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: true
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:ChangePassword'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'confirmForgotPassword',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: false
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:ConfirmForgotPassword'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'confirmSignUp',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: false
        },
        environment: {
          userPoolId: userPool.userPoolId,
          usersTableName: usersTable.tableName
        },
        initialPolicy: [
          new PolicyStatement({
            actions: [
              'cognito-idp:ConfirmSignUp',
              'cognito-idp:AdminGetUser',
              'cognito-idp:AdminDeleteUser'
            ],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'forgotPassword',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: false
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:ForgotPassword'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'getById',
        api: {
          httpMethod: HttpMethod.GET,
          isAuthNeeded: true,
          customApiPath: '{userId}'
        },
        environment: {
          usersTableName: usersTable.tableName
        }
      },
      {
        name: 'listUsers',
        skip: true,
        api: {
          httpMethod: HttpMethod.GET,
          isAuthNeeded: true
        },
        environment: {
          usersTableName: usersTable.tableName
        }
      },
      {
        name: 'login',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: false
        },
        environment: {
          usersTableName: usersTable.tableName
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:InitiateAuth'],
            resources: [
              userPool.userPoolArn
            ]
          }),
          new PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [`${usersTable.tableArn}/index/email_index`]
          })
        ]
      },
      {
        name: 'logout',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: true
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:GlobalSignOut'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'refreshToken',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: true
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:InitiateAuth'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'resendConfirmation',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: false
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:ResendConfirmationCode'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'signUp',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: false
        },
        initialPolicy: [
          new PolicyStatement({
            actions: ['cognito-idp:SignUp'],
            resources: [
              userPool.userPoolArn
            ]
          })
        ]
      },
      {
        name: 'updateById',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: true,
          customApiPath: '{userId}'
        },
        environment: {
          usersTableName: usersTable.tableName
        }
      },
      {
        name: 'verifyToken',
        api: {
          httpMethod: HttpMethod.POST,
          isAuthNeeded: true
        },
        environment: {
          userPoolId: userPool.userPoolId
        }
      }
    ];

    for (const definition of lambdaDefinitions) {
      const {
        name,
        skip,
        api
      } = definition;

      if (skip) {
        continue;
      }

      const nodeLambda = new NodeLambda(this, `${project}-${stack}-${name}-${stage}`, {
        ...definition,
        runtime: Runtime.NODEJS_14_X,
        functionName: `${project}-${stack}-${name}-${stage}`,
        entry: resolve(__dirname, '..', 'src', stack, `${name}.ts`),
        bundling: {
          minify: true
        },
        logRetention: isStagingEnv ? RetentionDays.INFINITE : RetentionDays.THREE_DAYS,
        projectRoot: resolve(__dirname, '..')
      });

      usersTable.grantFullAccess(nodeLambda);

      if (api) {
        const { httpMethod, customApiPath, isAuthNeeded } = api;

        const childResourceName = customApiPath ?? name;

        const apiRoute = apiSpecificRoute.getResource(childResourceName) ??
          new Resource(this, `${project}-${stack}-${name}Api-${stage}`, {
            parent: apiSpecificRoute,
            pathPart: childResourceName
          });

        const apiMethod = apiRoute.addMethod(
          httpMethod as HttpMethod,
          new LambdaIntegration(nodeLambda),
          { ...isAuthNeeded && authMethodOptions }
        );

        // Allows the specific route from api gateway to invoke said lambda function.
        nodeLambda.addPermission(`${project}-${stack}-${name}-InvokePermission-${stage}`, {
          principal: new ServicePrincipal('apigateway.amazonaws.com'),
          sourceArn: apiMethod.methodArn
        });
      }
    }
  }
}