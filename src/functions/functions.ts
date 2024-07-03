import { app, HttpRequest, HttpResponseInit, InvocationContext, output, Timer } from "@azure/functions";
import { GetLatestDataFromGitHub } from "../app/gitHubRepository";
import { RepositoryDataDocument, Settings } from "../app/common";
import { GetLatestDocument as GetLatestDocumentFromCosmosDB } from "../app/cosmosData";

const cosmosOutput = output.cosmosDB({
  connection: "CosmosConnection",
  databaseName: Settings.CosmosDatabaseId || "<Could not read app setting CosmosDatabaseId>",
  containerName: Settings.CosmosCollectionId || "<Could not read app setting CosmosCollectionId>",
  // containerName: "Container1",
  // createIfNotExists: true,
  // partitionKey: "/DateStatCreatedYYYYMM",
});

const projectsConfig: string[] | undefined = Settings.Repositories?.split(";");

export async function GetData(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!projectsConfig) {
    console.error("Could not read app setting 'Repositories'");
    return { status: 500, body: "An internal error has occurred." };
  }

  const projectName: string | null = request.query.get('project');
  if (!projectName) {
    return { status: 400, body: "Invalid parameters." };
  }

  const callback: string | null = request.query.get('callback');
  if (!callback) {
    return { status: 400, body: "Invalid parameters." };
  }

  const projectConfig = projectsConfig.find(x => x.toUpperCase().startsWith(projectName.toUpperCase()));
  if (!projectConfig) {
    return { status: 400, body: "Invalid parameters." };
  }

  context.log(`[${projectName}] Getting data...`);
  const cosmosDBDocument: RepositoryDataDocument = await GetLatestDocumentFromCosmosDB(projectName); // Query CosmosDB
  const cosmosDBDocumentStringified = JSON.stringify(cosmosDBDocument);
  return { body: `${callback}(${cosmosDBDocumentStringified});` };
};

export async function RefreshData(myTimer: Timer, context: InvocationContext): Promise<RepositoryDataDocument[] | undefined> {
  if (!projectsConfig) {
    console.error("Could not read app setting 'Repositories'");
    return;
  }

  let cosmosDBDocumentsOutput: Array<RepositoryDataDocument> = [];
  await Promise.all(projectsConfig.map(async projectConfig => {
    if (projectConfig.split(",")?.length !== 3) {
      console.error(`App setting 'Repositories' does not have the expected format: '${projectConfig}'`);
      return undefined;
    }

    const projectName: string = projectConfig.split(",")[0];
    const mainAssetName: string = projectConfig.split(",")[1];
    const additionalDownloadCount: number = Number(projectConfig.split(",")[2]);

    context.log(`[${projectName}] Getting data...`);
    let promises: Promise<RepositoryDataDocument>[] = new Array(2);
    promises[0] = GetLatestDataFromGitHub(projectName, mainAssetName, additionalDownloadCount); // Query GitHub
    promises[1] = GetLatestDocumentFromCosmosDB(projectName); // Query CosmosDB
    const [githubDocument, cosmosDBDocument] = await Promise.all(promises);

    if (githubDocument === undefined) {
      context.error(`[${projectName}] Could not get fresh data from GitHub, skip project.`);
      return;
    }

    if (cosmosDBDocument === undefined) {
      context.warn(`[${projectName}] Could not get latest document from CosmosDB, add latest CosmosDB document to output.`);
      cosmosDBDocumentsOutput.push(githubDocument);
    } else if (githubDocument.LatestReleaseDownloadCount !== cosmosDBDocument.LatestReleaseDownloadCount) {
      context.log(`[${projectName}] Adding a document to Cosmos DB because CosmosDB.LatestReleaseDownloadCount has ${cosmosDBDocument.LatestReleaseDownloadCount} and GitHub.LatestReleaseDownloadCount has ${githubDocument.LatestReleaseDownloadCount}...`);
      cosmosDBDocumentsOutput.push(githubDocument);
    } else {
      context.log(`[${projectName}] CosmosDB.LatestReleaseDownloadCount has ${cosmosDBDocument.LatestReleaseDownloadCount} and is up to date`);
    }
  }));

  // return undefined;
  return cosmosDBDocumentsOutput;
}

app.http('GetData', {
  methods: ['GET'],
  authLevel: 'function',
  handler: GetData
});

app.timer('RefreshData', {
  schedule: Settings.FuncRefreshDataSchedule,
  runOnStartup: true,
  handler: RefreshData,
  return: cosmosOutput
});