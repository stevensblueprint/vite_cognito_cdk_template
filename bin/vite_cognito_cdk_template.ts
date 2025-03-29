#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ViteCognitoCdkTemplateStack } from "../lib/vite_cognito_cdk_template-stack";
import { devProps, prodProps } from "../config";

const app = new cdk.App();
const envConfigs = [devProps, prodProps];
envConfigs.forEach((envConfig) => {
  if (envConfig.isDeploy) {
    const stackName = envConfig.stackName;
    console.log(`Deploying stack: ${stackName}`);
    new ViteCognitoCdkTemplateStack(app, stackName, {
      ...envConfig,
      description: `CRM Admin Infra Stack for ${envConfig.environmentType}`,
    });
  }
});

app.synth();
