/*
Cloning from one google drive to another across organizations is REALLY hard. You can move files, but not folders. 
There's no built in way to copy a whole directory tree from one drive to another. If you use Drive for Desktop you can't copy native google file formats (Docs, sheets, slides, ect.)

This script attempts to do the following: 
Copy all files & folders from one google drive folder to another
Recreate sharing permissions on folders
Handle situations where the clone job takes longer than the max runtime of scripts (6 min)

Setup: 
Modify targetParentFolderId to be the folder ID of the destination folder. Note, you need a FOLDER ID here not a shared drive ID. 

Usage: 
1. Run buildStatefile. 
    The script traverses SourceFolder and logs all files and folders to the jsonFilename. This step in the process is not tolerant to running out of time. It must complete in a single run. 
    The script writes out JSON data to statefileFilename in the root of the source folder. 
2. Run runCloneJob
    The script reads the statefile and skips any files that have already been copied. 
    It copies all remaining folders and recreates their edit and viewer permissions. 
    It copies any files inside each folder. 
    If the script runs longer than maxRuntime it creates a trigger to rerun the script after minToNextRun milliseconds and updates statefileFilename with the current state of the job. 
    If the script is completed successfully it emails the owner of the script and notifies them that the job is complete. 

*/


//Copy the root of the google drive. 
const sourceFolderId = DriveApp.getRootFolder().getId();
//ID of the destination folder. 
const targetParentFolderId = 'TARGETFOLDERIDHERE';
//The temporary state file - it will be written to the root of the source folder. 
const statefileFilename = 'driveClone.json';
//The time our execution is over. 
var endTime;
//Official max runtime is 6 minutes, although I've seen some scripts run up to 30 minutes. 
const maxRuntime = 5 * 60 * 1000;
//How long to wait to trigger another run of runCloneJob. 
const minToNextRun = 1 * 60 * 1000;
//******************************************************************
//Run this first to build the state file. We assume this process will take less than 6 minutes. 
function buildStatefile() {
  let driveTree = [];
  let sourceFolder = DriveApp.getFolderById(sourceFolderId);
  processDirectory_(sourceFolder, driveTree);
  writeStateFile_(JSON.stringify(driveTree));
}
//******************************************************************
function processDirectory_(source, driveTree) {

  let sourceName = source.getName();
  let sourceID = source.getId();
  let thisFolder = { type: "folder", name: sourceName, id: sourceID, destId: "", children: new Array(), editors: getEditorEmails_(source), viewers: getViewerEmails_(source) };
  Logger.log("Working on folder " + sourceName + " ID: " + sourceID);

  let folders = source.getFolders();
  Logger.log("\tGetting subfolders of " + sourceName + " ID: " + sourceID);
  while (folders.hasNext()) {
    let subFolder = folders.next();
    processDirectory_(subFolder, thisFolder.children);
  }

  let files = source.getFiles();
  Logger.log("\tGetting Files in " + sourceName + " ID: " + sourceID);
  while (files.hasNext()) {
    let file = files.next();
    thisFolder.children.push({ type: "file", name: file.getName(), id: file.getId(), destId: "" });
  }
  driveTree.push(thisFolder);
}
//******************************************************************
function clearTriggers_() {
  let triggers = ScriptApp.getProjectTriggers();
  for(let i=0;i<triggers.length;i++) {
    ScriptApp.deleteTrigger(triggers[i]);
    Utilities.sleep(1000);
  }
}
//******************************************************************
function writeStateFile_(content) {
  let destFolder = DriveApp.getFolderById(sourceFolderId);
  let fileList = destFolder.getFilesByName(statefileFilename);
  if (fileList.hasNext()) {
    // State file exists - replace content
    var file = fileList.next();
    file.setContent(content);
  }
  else {
    // state file doesn't exist. Create it. 
    destFolder.createFile(statefileFilename, content);
  }
}
//******************************************************************
function readStateFile_() {
  let destFolder = DriveApp.getFolderById(sourceFolderId);
  let fileList = destFolder.getFilesByName(statefileFilename);
  if (fileList.hasNext()) {
    // State file exists - replace content
    var file = fileList.next();
    return file.getBlob()
      .getDataAsString();
  }
  else {
    return null;
  }
}
//******************************************************************
function runCloneJob() {

  let statefileContents = readStateFile_();
  if(!statefileContents){
    Logger.log("Can't read statefile - bailing out");
    return;
  }
  var driveTree = JSON.parse(statefileContents);

  endTime = Date.now() + maxRuntime;
  cloneDir_(driveTree, targetParentFolderId);
  //If we're past our end time, it means we didn't complete the whole copy job. So set a trigger to run runCloneJob again.
  if (Date.now() >= endTime) {
    //There are a finite number of triggers a script can have. We have to clear them before creating a new one. 
    clearTriggers_();
    Logger.log("Execution time exceeded - Creating trigger to run in " + minToNextRun + " ms")
    ScriptApp.newTrigger("runCloneJob")
      .timeBased()
      .after(minToNextRun)
      .create();
  }
  else {
    //We're finished with the clone job, so clear any triggers and send an email.
    clearTriggers_();
    MailApp.sendEmail(Session.getActiveUser().getEmail(), "Drive clone complete", "The drive clone job has completed successfully")
  }
  writeStateFile_(JSON.stringify(driveTree));
}
//******************************************************************
function cloneDir_(driveTree, parentFolder) {
  for (let i = 0; i < driveTree.length; i++) {
    if (Date.now() >= endTime) {
      Logger.log("Timeout reached");
      return;
    }

    if (driveTree[i].type == "folder") {
      if (!driveTree[i].destId) {
        Logger.log("Creating folder " + driveTree[i].name);
        let newFolder = DriveApp.getFolderById(parentFolder).createFolder(driveTree[i].name);
        driveTree[i].destId = newFolder.getId();
        if (driveTree[i].editors && driveTree[i].editors.length > 0) {
          newFolder.addEditors(driveTree[i].editors);
        }
        if (driveTree[i].viewers && driveTree[i].viewers.length > 0) {
          newFolder.addViewers(driveTree[i].viewers);
        }
      }
      else {
        Logger.log("Folder exists - Reusing " + driveTree[i].name)
      }
    } else {
      if (!driveTree[i].destId) {
        Logger.log("Copying file " + driveTree[i].name);
        let sourceFile = DriveApp.getFileById(driveTree[i].id);
        let destFile;
        //I've encountered some files that can't be copied. 
        try {
          destFile = sourceFile.makeCopy(driveTree[i].name, DriveApp.getFolderById(parentFolder));
          driveTree[i].destId = destFile.getId();
        }
        catch(error) {
          Logger.log("Failed copying file " + driveTree[i].name + " " + error);
          driveTree[i].destId = "FAILED";
        }
      }
      else {
        Logger.log("File already copied. Skipping " + driveTree[i].name);
      }
    }
    if (driveTree[i].children) {
      cloneDir_(driveTree[i].children, driveTree[i].destId)
    }
  }
}
//******************************************************************
function getEditorEmails_(folder) {
  let rv = [];
  let userList = folder.getEditors();
  for (let i = 0; i < userList.length; i++) {
    rv.push(userList[i].getEmail());
  }
  return rv;
}
//******************************************************************
function setEditors_(folder, editorList) {
  for (let i = 0; i < editorList.length; i++) {

  }
  let userList = folder.getEditors();
  for (let i = 0; i < userList.length; i++) {
    rv.push(userList[i].getEmail());
  }
  return rv;
}
//******************************************************************
function getViewerEmails_(folder) {
  let rv = [];
  let userList = folder.getViewers();
  for (let i = 0; i < userList.length; i++) {
    rv.push(userList[i].getEmail());
  }
  return rv;
}



















