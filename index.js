/*
              _____      ______
             |     |    /     /
             |     |  /     /
             |     |/     /
             |          /
             |          \
             |    /\      \
             |  /    \      \
             |/        \______\

+++++++++++++++++++++++++++++++++++++++++++++++
 _  _____ ____  ____   _    _       ____ ____
| |/ /_ _|  _ \|  _ \ / \  | |     / ___/ _  \
| ' / | || |_) | |_) / _ \ | |    | |  | | | |
| . \ | ||  _ <|  __/ ___ \| |___ | |__| |_| |
|_|\_\___|_| \_\_| /_/   \_\_____(_)____\___/

*/
'use strict'

const {app, BrowserWindow, ipcMain} = require('electron')
var torrent = require("./torrent"),
  resume = require("./resume"),
  store = require("./store"),
  storeProgress = require("./storeProgress"),
  storeConfig = require("./storeConfig"),
  fs = require("fs"),
  path = require("path"),
  pump = require("pump"),
  rangeParser = require("range-parser"),
  express = require("express"),
  api = express(),
  torrents = {},
  isFullscreen = false,
  streamPort = storeConfig.get("port").value,
  libraryLocation = storeConfig.get("library").value;

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win
let settingsWin

function createWindow () {
  torrents = resume();
  // Create the browser window.
  win = new BrowserWindow({
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icons", "512x512.png")
  })

  // and load the index.html of the app.
  win.loadURL(`file://${__dirname}/index.html`)
  win.setMenu(null)
  win.webContents.on('new-window', function(e, url) {
    e.preventDefault();
    require('electron').shell.openExternal(url);
  });

  // Emitted when the window is closed.
  win.on('closed', () => {
    //stop all torrents
    Object.keys(torrents).forEach(function(id){
      torrents[id].destroy();
      delete torrents[id]
    });
    //save incomplete/complete torrents to downloads.json
    store.save()
    //dereference window object
    win = null
  })

  //get data for the browsing page's windows
  ipcMain.on("getPage", function(event, page){
    if(page === "home"){
      //get template html file
      event.returnValue = fs.readFileSync(path.join(app.getPath("appData"), "cascade", "home.html"), "utf8");
    }else if(page === "library"){
      //get torrents
      event.returnValue = store.get();
    }
  })

  ipcMain.on("openSettings", function(event, page){
    //new settings window
    settingsWin = new BrowserWindow({
      autoHideMenuBar: true,
      icon: path.join(__dirname, "icons", "512x512.png")
    })

    // and load settings of the app.
    settingsWin.loadURL(`file://${__dirname}/settings/index.html`)
    // Emitted when the window is closed.
    settingsWin.on('closed', () => {
      //dereference window object
      settingsWin = null
    })
    ipcMain.on("getConfig", function(event){
      event.returnValue = storeConfig.getAll();
    })
    ipcMain.on("storeConfig", function(event, config){
      if(Object.keys(storeConfig.getAll()).indexOf(config.setting) !== -1){
        if(storeConfig.get(config.setting).type === "text"){
          if(typeof config.value === "string"){
            storeConfig.store(config.setting, "value", config.value);
            event.returnValue = config.value;
          }else{
            event.returnValue = storeConfig.get(config.setting).value;
          }
        }else if(storeConfig.get(config.setting).type === "number"){
          if(typeof parseInt(config.value) === "number"){
            storeConfig.store(config.setting, "value", config.value);
            event.returnValue = config.value;
          }else{
            event.returnValue = storeConfig.get(config.setting).value;
          }
        }else if(storeConfig.get(config.setting).type === "directory"){
          if(fs.existsSync(config.value)){
            storeConfig.store(config.setting, "value", config.value);
            event.returnValue = config.value;
          }else{
            event.returnValue = storeConfig.get(config.setting).value;
          }
        }else if(storeConfig.get(config.setting).type === "boolean"){
          if(typeof config.value === "boolean"){
            storeConfig.store(config.setting, "value", config.value);
            event.returnValue = config.value;
          }else{
            event.returnValue = storeConfig.get(config.setting).value;
          }
        }
      }
    })
  })

  ipcMain.on('stream', function(event, movie){
    //when play button is clicked on a movie
    if(!torrents[movie.id]){
      torrents[movie.id] = torrent(movie, false);
    }
    win.loadURL(`file://${__dirname}/player/index.html`);

    ipcMain.on("exitStreaming", function(event){
      win.loadURL(`file://${__dirname}/index.html`);
      if(!torrents[movie.id].download){
        torrents[movie.id].destroy();
        delete torrents[movie.id]
      }
    })

    //sent to get the movie object
    ipcMain.on("playMovie", function(event){
      //respond with movie object and streaming port once torrent is ready
      torrents[movie.id].on("ready", function(){
        event.sender.send("playMovie", movie)
        event.sender.send("streamPort", streamPort)
      })
    });
    //when metadata for video is loaded
    ipcMain.on("metadata", function(event, duration){
      //send starting values
      event.sender.send("volume", {volume: 0.75, update: true})
      event.sender.send("progress", {progress: (typeof storeProgress.get(movie.id) === 'undefined') ? 0 : storeProgress.get(movie.id) * duration, total: duration, update: true})
      event.sender.send("playback", true)

      ipcMain.on('playback', function(event, state){
        //play/pause
        event.sender.send("playback", state)
      })
      ipcMain.on('volume', function(event, data){
        //set volume
        event.sender.send("volume", data)
      })
      ipcMain.on('progress', function(event, data){
        //movie progress
        //store progress in progress.json
        storeProgress.store(data.progress, data.total, data.id);
        event.sender.send("progress", data);
      })
      ipcMain.on("fullscreen", function(event, state){
        //change fullscreen state
        var setState = (state === null) ? !isFullscreen : state;
        isFullscreen = setState;
        win.setFullScreen(setState);
        event.sender.send("fullscreen", state)
      })
    })
  })
  ipcMain.on('download', function(event, movie){
    //when download button on movie is pressed
    if(torrents[movie.id] && !torrents[movie.id].download){
      torrents[movie.id].destroy()
    }
    torrents[movie.id] = torrent(movie, true);
  })
}
//ready to make windows
app.on('ready', createWindow)

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  //quit app (except on macOS)
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  //create window on mac if icon pressed
  if (win === null) {
    createWindow()
  }
})

api.post('/playback/', function(req, res){
  var state = (req.query.state === "play") ? true : (req.query.state === "pause") ? false : null;
  win.webContents.send("playback", state)
})
api.post('/volume/:volume', function(req, res){
  var update = (typeof req.query.update === "undefined") ? true : update;
  var data = {volume: req.params.volume, update: update};
  win.webContents.send("volume", data)
})
api.post('/progress/:progress/:total', function(req, res){
  var update = (typeof req.query.update === "undefined") ? true : update;
  var data = {progress: req.params.progress, total: req.params.total, update: update};
  win.webContents.send("progress", data)
})
api.post('/fullscreen/:state', function(req, res){
  var state = (req.query.state === "enter") ? true : (req.query.state === "exit") ? false : null;
  var setState = (state === null) ? !isFullscreen : state;
  isFullscreen = setState;
  win.setFullScreen(setState);
  win.webContents.send("fullscreen", state)
})

api.all('/stream/:id', function (req, res) {
  if(store.get().complete.indexOf(req.params.id) !== -1){
    var file = {
      name: req.params.id + ".mp4",
      path: path.join(libraryLocation, req.params.id + ".mp4"),
      length: fs.statSync(path.join(libraryLocation, req.params.id + ".mp4")).size
    }
    var range = req.headers.range;
    range = range && rangeParser(file.length, range)[0];
    res.setHeader('Accept-Ranges', 'bytes');
    res.type(file.name);
    req.connection.setTimeout(3600000);

    if (!range) {
      res.setHeader('Content-Length', file.length);
      if (req.method === 'HEAD') {
        return res.end();
      }
      return pump(fs.createReadStream(file.path, {start: range.start, end: range.end}), res);
    }

    res.statusCode = 206;
    res.setHeader('Content-Length', range.end - range.start + 1);
    res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + file.length);

    if (req.method === 'HEAD') {
      return res.end();
    }
    pump(fs.createReadStream(file.path, {start: range.start, end: range.end}), res);
  }else{
    if(Object.keys(torrents).indexOf(req.params.id) === -1) {
      return res.sendStatus(404);
    }
    var torrent = torrents[req.params.id],
      file = torrent.file;

    var range = req.headers.range;
    range = range && rangeParser(file.length, range)[0];
    res.setHeader('Accept-Ranges', 'bytes');
    res.type(file.name);
    req.connection.setTimeout(3600000);

    if (!range) {
      res.setHeader('Content-Length', file.length);
      if (req.method === 'HEAD') {
        return res.end();
      }
      return pump(file.createReadStream(), res);
    }

    res.statusCode = 206;
    res.setHeader('Content-Length', range.end - range.start + 1);
    res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + file.length);

    if (req.method === 'HEAD') {
      return res.end();
    }
    pump(file.createReadStream(range), res);
  }
});

api.listen(streamPort)
