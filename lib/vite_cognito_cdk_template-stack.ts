import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontorigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as cpa from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dotenv from "dotenv";
import { Construct } from "constructs";
import path = require("path");

interface ViteCognitoCdkTemplateStackProps extends cdk.StackProps {
  environmentType: string;
  branch: string;
  pipelineName: string;
  bucketName: string;
  pipelineBucket: string;
  publicAccess: boolean;
  indexFile: string;
  errorFile: string;
  githubRepoOwner: string;
  githubRepoName: string;
  githubAccessToken: string;
  userPoolName: string;
}

export class ViteCognitoCdkTemplateStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: ViteCognitoCdkTemplateStackProps
  ) {
    super(scope, id, props);

    /*------------------------cognito---------------------------*/
    const { cognitoUserPool: userPool, userPoolClient } =
      this._createUserPool(props);

    /*------------------------react deployment---------------------------*/
    const webBucket = this._createWebBucket(props);
    const distribution = this._createCloudFrontDistribution(webBucket, props);

    /*------------------------codepipeline/cicd--------------------------*/
    const { sourceOutput, sourceAction } = this._createSourceAction(props);
    const { buildOutput, buildProject } = this._createBuildProject(
      distribution,
      props,
      userPool.userPoolId,
      userPoolClient.userPoolClientId
    );
    const buildAction = this._createBuildAction(
      buildProject,
      sourceOutput,
      buildOutput
    );
    const deployAction = this._createDeployAction(buildOutput, webBucket);
    this._createPipeline(
      deployAction,
      sourceAction,
      buildAction,
      props,
      webBucket,
      distribution
    );
    this._outCloudfrontURL(distribution);
    this._outS3BucketURL(webBucket);
  }

  /*--------------------------react deployment---------------------------*/
  private _createWebBucket(props: ViteCognitoCdkTemplateStackProps) {
    const { bucketName, indexFile, errorFile } = props;

    const webBucket = new s3.Bucket(this, bucketName, {
      websiteIndexDocument: indexFile,
      websiteErrorDocument: errorFile,
      publicReadAccess: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      accessControl: s3.BucketAccessControl.PRIVATE,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
    });

    return webBucket;
  }

  private _createCloudFrontDistribution(
    bucket: s3.Bucket,
    props: ViteCognitoCdkTemplateStackProps
  ) {
    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [bucket.arnForObjects("*")],
        principals: [
          new iam.CanonicalUserPrincipal(
            oai.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    );

    const s3Origin = new cloudfrontorigins.S3Origin(bucket, {
      originAccessIdentity: oai,
    });

    const distribution = new cloudfront.Distribution(
      this,
      `${props.stackName}`,
      {
        defaultBehavior: {
          origin: s3Origin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        defaultRootObject: "index.html",
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 404,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.seconds(300),
          },
          {
            httpStatus: 403,
            responseHttpStatus: 500,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.seconds(300),
          },
        ],
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      }
    );

    return distribution;
  }

  /*--------------------------codepipeline/cicd---------------------------*/
  private _createSourceAction(props: ViteCognitoCdkTemplateStackProps) {
    const { githubRepoOwner, githubRepoName, githubAccessToken, branch } =
      props;
    const sourceOutput = new codepipeline.Artifact();
    const sourceAction = new cpa.GitHubSourceAction({
      actionName: "GitHub",
      owner: githubRepoOwner,
      repo: githubRepoName,
      branch: branch,
      oauthToken: cdk.SecretValue.secretsManager(githubAccessToken),
      output: sourceOutput,
    });

    return {
      sourceOutput,
      sourceAction,
    };
  }

  private _createUserPool(props: ViteCognitoCdkTemplateStackProps) {
    const cognitoUserPool = new cognito.UserPool(this, props.userPoolName, {
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
        username: false,
      },
      standardAttributes: {
        email: {
          required: true,
        },
        givenName: {
          required: true,
          mutable: true,
        },
        familyName: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const userPoolClient = new cognito.UserPoolClient(
      this,
      `${props.userPoolName}Client`,
      {
        userPool: cognitoUserPool,
        authFlows: {
          userPassword: true,
          userSrp: true,
        },
        generateSecret: false,
        oAuth: {
          flows: {
            authorizationCodeGrant: true,
          },
          scopes: [
            cognito.OAuthScope.OPENID,
            cognito.OAuthScope.EMAIL,
            cognito.OAuthScope.PROFILE,
          ],
        },
      }
    );

    new cdk.CfnOutput(this, "UserPoolId", {
      value: cognitoUserPool.userPoolId,
      description: "Cognito User Pool ID",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Cognito User Pool Client ID",
    });

    return { cognitoUserPool, userPoolClient };
  }

  private _createBuildProject(
    distribution: cloudfront.Distribution,
    props: ViteCognitoCdkTemplateStackProps,
    userPoolId: string,
    userPoolClientId: string
  ) {
    const envVariables = loadEnvFile();
    const updatedVariables = {
      ...envVariables,
      VITE_USER_POOL_ID: { value: userPoolId },
      VITE_USER_POOL_CLIENT_ID: { value: userPoolClientId },
    };
    const buildOutput = new codepipeline.Artifact();
    const buildProject = new codebuild.Project(
      this,
      `${props.stackName}-codebuild`,
      {
        buildSpec: codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            install: {
              "runtime-versions": {
                nodejs: "latest",
              },
              commands: ['echo "installing npm dependencies"', "npm install"],
            },
            build: {
              commands: ['echo "building app"', "npm run build"],
            },
            post_build: {
              commands: [
                'echo "creating cloudfront invalidation"',
                `aws cloudfront create-invalidation --distribution-id ${distribution.distributionId} --paths '/*'`,
              ],
            },
          },
          artifacts: {
            "base-directory": "dist",
            files: ["**/*"],
          },
          caches: {
            path: "./node_modules/**/*",
          },
        }),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
          privileged: true,
          environmentVariables: updatedVariables,
        },
      }
    );

    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        ],
      })
    );

    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
        resources: [buildProject.projectArn],
      })
    );

    return {
      buildOutput,
      buildProject,
    };
  }

  private _createBuildAction(
    buildProject: codebuild.Project,
    sourceOutput: codepipeline.Artifact,
    buildOutput: codepipeline.Artifact
  ) {
    const buildAction = new cpa.CodeBuildAction({
      actionName: "CodeBuild",
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    return buildAction;
  }

  private _createDeployAction(
    buildOutput: codepipeline.Artifact,
    bucket: s3.Bucket
  ) {
    const deployAction = new cpa.S3DeployAction({
      actionName: "DeployToS3",
      input: buildOutput,
      bucket: bucket,
    });

    return deployAction;
  }

  private _createPipeline(
    deployAction: cpa.S3DeployAction,
    sourceAction: cpa.GitHubSourceAction,
    buildAction: cpa.CodeBuildAction,
    props: ViteCognitoCdkTemplateStackProps,
    bucket: s3.Bucket,
    distribution: cloudfront.Distribution
  ) {
    const { pipelineName } = props;

    const stages = [
      { stageName: "Source", actions: [sourceAction] },
      { stageName: "Build", actions: [buildAction] },
      { stageName: "Deploy", actions: [deployAction] },
    ];

    const codePipeline = new codepipeline.Pipeline(this, "codepipeline", {
      pipelineName: pipelineName,
      restartExecutionOnUpdate: true,
      stages,
    });

    codePipeline.node.addDependency(bucket, distribution);
  }

  private _outCloudfrontURL(distribution: cloudfront.Distribution) {
    new cdk.CfnOutput(this, "cloudfront-web-url", {
      value: distribution.distributionDomainName,
      description: "cloudfront website url",
    });
  }

  private _outS3BucketURL(bucket: s3.Bucket) {
    new cdk.CfnOutput(this, "s3-bucket-web-url", {
      value: bucket.bucketWebsiteUrl,
      description: "s3 bucket website url",
    });
  }
}

function convertEnvVariables(env: dotenv.DotenvParseOutput): {
  [key: string]: { value: string };
} {
  return Object.keys(env).reduce((acc, key) => {
    acc[key] = { value: env[key] };
    return acc;
  }, {} as { [key: string]: { value: string } });
}

function loadEnvFile() {
  const envFilePath = path.join(__dirname, "../config/.env");
  const result = dotenv.config({ path: envFilePath });
  if (result.error) {
    throw result.error;
  }
  if (!result.parsed) {
    throw new Error("Failed to load environment variables from .env file");
  }
  return convertEnvVariables(result.parsed);
}
