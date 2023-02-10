/*
Transferring from one google drive to another across organizations is REALLY hard. You can move files, but not folders. 
There's no built in way to copy a whole directory tree from one drive to another. If you use Drive for Desktop you can't copy native google file formats (Docs, sheets, slides, ect.)
This script attempts to do the following: 
Copy all files & folders from one google drive folder to another
Recreate sharing permissions on folders
Handle situations where the clone job takes longer than the max runtime of scripts (6 min)
Setup: 
Modify targetParentFolderId to be the folder ID of the destination folder. Note, you need a FOLDER ID here not a shared drive ID. 
If you don't want to copy a whole google drive You can modify sourceFolderId to be the ID number of the folder you want to copy. 
Usage:
Run runCloneJob
  The script traverses SourceFolder and writes all files and folders an object.
    This step in the process is not tolerant to running out of time. The script can traverse VERY large trees in 6 minutes.
  It traverses the object and copies files and folders.
   If it runs up against the timeout limit it creates a trigger to rerun the script after minToNextRun milliseconds and updates statefileFilename with the current state of the job.
   If the script is completed successfully it emails the owner of the script and notifies them that the job is complete.
   The stateFileFilename stays intact and can be read with a text editor. It has statistics like job start, end, and total runtime.
*/
//Copy the root of the google drive. 
const sourceFolderId = DriveApp.getRootFolder().getId();
//ID of the destination folder. 
const targetParentFolderId = 'TARGETPARENTFOLDERID';
//The temporary state file - it will be written to the root of the source folder. 
const statefileFilename = 'driveClone.json';
//Official max runtime is 6 minutes, although I've seen some scripts run up to 30 minutes. 
const maxRuntime = 5 * 60 * 1000;
//How long to wait to trigger another run of runCloneJob. 
const minToNextRun = 1 * 60 * 1000;
let cloneJob;
//******************************************************************
function runCloneJob() {
  let sourceFolder = DriveApp.getFolderById(sourceFolderId);
  cloneJob = readStateFile_();
  cloneJob.timeout = Date.now() + maxRuntime;
  if (cloneJob.phase == 1) {
    buildStatefile_(cloneJob.tree, sourceFolder);
    cloneJob.phase = 2;
  }
  if (cloneJob.phase == 2) {
    copyDir_(cloneJob.tree, targetParentFolderId);
  }
  //If we're past our end time, it means we didn't complete the whole copy job. So set a trigger to run runCloneJob again.
  if (Date.now() >= cloneJob.timeout) {
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
    cloneJob.end = Date.now();
    cloneJob.phase = 3;
    cloneJob.totalRuntime = (cloneJob.end - cloneJob.start) / 60000
    clearTriggers_();
    MailApp.sendEmail(Session.getActiveUser().getEmail(), "Drive clone complete", "The drive clone job has completed successfully\n\n" +
      "\nFolders copied: " + cloneJob.folderCount +
      "\nFiles copied: " + cloneJob.fileCount +
      "\nFailures: " + cloneJob.failures +
      "\nTotal Runtime: " + Math.round(cloneJob.totalRuntime) + " Minutes\n");
  }
  writeStateFile_(cloneJob);
}
//******************************************************************
function buildStatefile_(driveTree, source) {

  let sourceName = source.getName();
  let sourceID = source.getId();
  let thisFolder = { type: "folder", name: sourceName, id: sourceID, destId: "", children: new Array(), editors: getEditorEmails_(source), viewers: getViewerEmails_(source) };
  Logger.log("Entering folder " + sourceName + " ID: " + sourceID);

  let folders = source.getFolders();
  while (folders.hasNext()) {
    let subFolder = folders.next();
    buildStatefile_(thisFolder.children, subFolder);
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
  for (let i = 0; i < triggers.length; i++) {
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
    file.setContent(JSON.stringify(content));
  }
  else {
    // state file doesn't exist. Create it. 
    destFolder.createFile(statefileFilename, JSON.stringify(content));
  }
}
//******************************************************************
function readStateFile_() {
  let destFolder = DriveApp.getFolderById(sourceFolderId);
  let fileList = destFolder.getFilesByName(statefileFilename);
  let rv = null;
  if (fileList.hasNext()) {
    var file = fileList.next();
    rv = JSON.parse(file.getBlob().getDataAsString());
  }
  else {
    rv = {
      start: Date.now(),
      timeout: Date.now() + maxRuntime,
      phase: 1,
      end: 0,
      totalRuntime: 0,
      fileCount: 0,
      folderCount: 0,
      failures: 0,
      failureList: [],
      tree: []
    };
  }
  return rv;
}
//******************************************************************
function copyDir_(driveTree, parentFolder) {
  for (let i = 0; i < driveTree.length; i++) {
    if (Date.now() >= cloneJob.timeout) {
      Logger.log("Timeout reached");
      return;
    }

    if (driveTree[i].type == "folder") {
      if (!driveTree[i].destId) {
        Logger.log("Creating folder " + driveTree[i].name);
        let newFolder = DriveApp.getFolderById(parentFolder).createFolder(driveTree[i].name);
        driveTree[i].destId = newFolder.getId();
        cloneJob.folderCount++;
        if (driveTree[i].editors && driveTree[i].editors.length > 0) {
          newFolder.addEditors(driveTree[i].editors);
        }
        if (driveTree[i].viewers && driveTree[i].viewers.length > 0) {
          newFolder.addViewers(driveTree[i].viewers);
        }
      }
      else {
        Logger.log("Folder exists " + driveTree[i].name)
      }
    } else {
      if (!driveTree[i].destId) {
        Logger.log("Copying file " + driveTree[i].name);
        let sourceFile = DriveApp.getFileById(driveTree[i].id);
        let destFile;
        //Have to wrap the copy operation in a try block. Some files can't be copied. 
        try {
          destFile = sourceFile.makeCopy(driveTree[i].name, DriveApp.getFolderById(parentFolder));
          driveTree[i].destId = destFile.getId();
          cloneJob.fileCount++;
        }
        catch (error) {
          Logger.log("Failed copying file " + driveTree[i].name + " " + error);
          driveTree[i].destId = "FAILED";
          cloneJob.failures++;
          cloneJob.failureList.push({ "name": sourceFile.getName(), "id": sourceFile.getId(), "message": error });
        }
      }
      else {
      }
    }
    if (driveTree[i].children) {
      copyDir_(driveTree[i].children, driveTree[i].destId)
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

