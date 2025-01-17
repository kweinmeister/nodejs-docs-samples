// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const {assert} = require('chai');
const {after, before, describe, it} = require('mocha');
const sinon = require('sinon');
const uuid = require('uuid');
const cp = require('child_process');
const {Storage} = require('@google-cloud/storage');
const {createSavedQuery} = require('../createSavedQuery.js');
const {deleteSavedQuery} = require('../deleteSavedQuery.js');
const {getSavedQuery} = require('../getSavedQuery.js');
const {listSavedQueries} = require('../listSavedQueries.js');
const {updateSavedQuery} = require('../updateSavedQuery.js');
const {ProjectsClient} = require('@google-cloud/resource-manager').v3;

const execSync = cmd => cp.execSync(cmd, {encoding: 'utf-8'});

const storage = new Storage();
const bucketName = `asset-nodejs-${uuid.v4()}`;
const bucket = storage.bucket(bucketName);
const fileSuffix = `${uuid.v4()}`;
const queryId = 'new-query-id';

const {BigQuery} = require('@google-cloud/bigquery');
const bigquery = new BigQuery();
const options = {
  location: 'US',
};
const datasetId = `asset_nodejs_${uuid.v4()}`.replace(/-/gi, '_');

const compute = require('@google-cloud/compute');
const instancesClient = new compute.InstancesClient();
const projectClient = new ProjectsClient();

// Some of these tests can take an extremely long time, and occasionally
// timeout, see:
// "Timeout of 180000ms exceeded. For async tests and hooks".
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('quickstart sample tests', () => {
  let projectId;
  let projectNumericalId;
  let savedQueryFullName;
  let zone;
  let instanceName;
  let machineType;
  let sourceImage;
  let networkName;
  const stubConsole = function () {
    sinon.stub(console, 'error');
    sinon.stub(console, 'log');
  };

  //Restore console
  const restoreConsole = function () {
    console.log.restore();
    console.error.restore();
  };

  before(async () => {
    zone = 'us-central1-a';
    instanceName = `asset-nodejs-${uuid.v4()}`;
    machineType = 'n1-standard-1';
    sourceImage =
      'projects/ubuntu-os-cloud/global/images/family/ubuntu-1804-lts';
    networkName = 'global/networks/default';
    projectId = await instancesClient.getProjectId();
    const projectRequest = {
      name: `projects/${projectId}`,
    };
    const [projectResponse] = await projectClient.getProject(projectRequest);
    projectNumericalId = projectResponse.name;
    savedQueryFullName = `${projectNumericalId}/savedQueries/${queryId}`;
    await bucket.create();
    await bigquery.createDataset(datasetId, options);
    await bigquery.dataset(datasetId).exists();

    const [response] = await instancesClient.insert({
      instanceResource: {
        name: instanceName,
        disks: [
          {
            // Describe the size and source image of the boot disk to attach to the instance.
            initializeParams: {
              diskSizeGb: '10',
              sourceImage,
            },
            autoDelete: true,
            boot: true,
            type: 'PERSISTENT',
          },
        ],
        machineType: `zones/${zone}/machineTypes/${machineType}`,
        networkInterfaces: [
          {
            // Use the network interface provided in the networkName argument.
            name: networkName,
          },
        ],
      },
      project: projectId,
      zone,
    });
    let operation = response.latestResponse;
    const operationsClient = new compute.ZoneOperationsClient();

    // Wait for the create operation to complete.
    while (operation.status !== 'DONE') {
      [operation] = await operationsClient.wait({
        operation: operation.name,
        project: projectId,
        zone: operation.zone.split('/').pop(),
      });
    }
  });

  after(async () => {
    await bucket.delete();
    await bigquery.dataset(datasetId).delete({force: true}).catch(console.warn);
    const [response] = await instancesClient.delete({
      instance: instanceName,
      project: projectId,
      zone,
    });
    let operation = response.latestResponse;
    const operationsClient = new compute.ZoneOperationsClient();

    // Wait for the delete operation to complete.
    while (operation.status !== 'DONE') {
      [operation] = await operationsClient.wait({
        operation: operation.name,
        project: projectId,
        zone: operation.zone.split('/').pop(),
      });
    }
  });
  beforeEach(stubConsole);
  afterEach(restoreConsole);

  it('should export assets to specified path', async () => {
    const dumpFilePath = `gs://${bucketName}/my-assets-${fileSuffix}.txt`;
    execSync(`node exportAssets ${dumpFilePath}`);
    let waitMs = 4000;
    let exists = false;
    let file;
    for (let retry = 0; retry < 3 && !exists; ++retry) {
      await sleep((waitMs *= 2));
      file = await bucket.file(`my-assets-${fileSuffix}.txt`);
      exists = await file.exists();
    }
    assert.ok(exists);
    await file.delete();
  });

  it('should export asset relationships to specified path', async () => {
    const dumpFilePath = `gs://${bucketName}/my-relationships-${fileSuffix}.txt`;
    const contentType = 'RELATIONSHIP';
    execSync(`node exportAssets ${dumpFilePath} ${contentType}`);
    let waitMs = 4000;
    let exists = false;
    let file;
    for (let retry = 0; retry < 3 && !exists; ++retry) {
      await sleep((waitMs *= 2));
      file = await bucket.file(`my-relationships-${fileSuffix}.txt`);
      exists = await file.exists();
    }
    assert.ok(exists);
    await file.delete();
  });

  // The assets returned within 'readTimeWindow' frequently do not include
  // the newly created bucket:
  it('should get assets history successfully', async () => {
    const assetName = `//storage.googleapis.com/${bucketName}`;
    let waitMs = 1000;
    let included = false;
    for (let retry = 0; retry < 3 && !included; ++retry) {
      await sleep((waitMs *= 2));
      const stdout = execSync(
        `node getBatchAssetHistory ${assetName} 'RESOURCE'`
      );
      included = stdout.includes(assetName);
    }
    assert.ok(included);
  });

  it('should run the quickstart', async () => {
    const assetName = `//storage.googleapis.com/${bucketName}`;
    const stdout = execSync(`node quickstart ${assetName}`);
    assert.include(stdout, assetName);
  });

  // https://github.com/googleapis/nodejs-asset/issues/650
  it.skip('should search all resources successfully', async () => {
    const query = `name:${instanceName}`;
    const stdout = execSync(`node searchAllResources '' ${query}`);
    assert.include(stdout, instanceName);
  });

  it('should search all iam policies successfully', async () => {
    const query = 'policy:roles/owner';
    const stdout = execSync(`node searchAllIamPolicies '' ${query}`);
    assert.include(stdout, 'roles/owner');
  });

  it('should list assets successfully', async () => {
    const assetType = 'storage.googleapis.com/Bucket';
    const stdout = execSync(`node listAssets ${assetType} 'RESOURCE'`);
    assert.include(stdout, assetType);
  });

  it('should list asset relationship successfully', async () => {
    const stdout = execSync("node listAssets '' 'RELATIONSHIP'");
    assert.include(stdout, 'relatedAsset');
  });

  it('should get effective iam policies successfully', async () => {
    const assetName = `//storage.googleapis.com/${bucketName}`;
    const stdout = execSync(`node getBatchEffectiveIamPolicies ${assetName}`);
    assert.include(stdout, assetName);
  });

  it('should analyze iam policy successfully', async () => {
    const stdout = execSync('node analyzeIamPolicy');
    assert.include(stdout, '//cloudresourcemanager.googleapis.com/projects');
  });

  it('should analyze iam policy and write analysis results to gcs successfully', async () => {
    const uri = `gs://${bucketName}/my-analysis.json`;
    execSync(`node analyzeIamPolicyLongrunningGcs ${uri}`);
    let waitMs = 1000;
    let exists = false;
    let file;
    for (let retry = 0; retry < 3 && !exists; ++retry) {
      await sleep((waitMs *= 2));
      file = await bucket.file('my-analysis.json');
      exists = await file.exists();
    }
    assert.ok(exists);
    await file.delete();
  });

  it('should analyze iam policy and write analysis results to bigquery successfully', async () => {
    const tablePrefix = 'analysis_nodejs';
    execSync(
      `node analyzeIamPolicyLongrunningBigquery ${datasetId} ${tablePrefix}`
    );
    let waitMs = 4000;
    let metadataTable;
    let metadataTable_exists = false;
    let resultsTable;
    let resultsTable_exists = false;

    for (
      let retry = 0;
      retry < 3 && !(metadataTable_exists || resultsTable_exists);
      ++retry
    ) {
      await sleep((waitMs *= 2));
      metadataTable = await bigquery
        .dataset(datasetId)
        .table('analysis_nodejs_analysis');
      metadataTable_exists = await metadataTable.exists();
      resultsTable = await bigquery
        .dataset(datasetId)
        .table('analysis_nodejs_analysis_result');
      resultsTable_exists = await resultsTable.exists();
    }

    assert.ok(metadataTable_exists);
    assert.ok(resultsTable_exists);
    await metadataTable.delete();
    await resultsTable.delete();
  });

  it('should get effective iam policies successfully', async () => {
    const assetName = `//storage.googleapis.com/${bucketName}`;
    const stdout = execSync(`node getBatchEffectiveIamPolicies ${assetName}`);
    assert.include(stdout, assetName);
  });

  it('should create saved query successfully', async () => {
    const description = 'description';
    await createSavedQuery(queryId, description);
    assert.include(console.log.firstCall.args, savedQueryFullName);
  });

  it('should list saved queries successfully', async () => {
    await listSavedQueries();
    assert.include(
      console.log.lastCall.args,
      'Listed saved queries successfully.'
    );
  });

  it('should get saved query successfully', async () => {
    await getSavedQuery(savedQueryFullName);
    assert.include(console.log.firstCall.args, savedQueryFullName);
  });

  it('should update saved query successfully', async () => {
    const newDescription = 'newDescription';
    await updateSavedQuery(savedQueryFullName, newDescription);
    assert.include(console.log.firstCall.args, savedQueryFullName);
    assert.include(console.log.secondCall.args, newDescription);
  });

  it('should delete saved query successfully', async () => {
    await deleteSavedQuery(savedQueryFullName);
    assert.deepEqual(console.log.firstCall.args, [
      'Deleted saved query:',
      savedQueryFullName,
    ]);
  });
});
