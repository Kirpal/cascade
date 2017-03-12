'use strict'

const {app, BrowserWindow, ipcMain, Menu, dialog} = require('electron');
const autoUpdater = require("electron-updater").autoUpdater;
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
  request = require("request"),
  api = express(),
  torrents = {},
  streamPort = storeConfig.get("port").value,
  libraryLocation = storeConfig.get("library").value,
  current = {
    movie: {},
    volume: 0.75,
    progress: 0,
    playing: false,
    fullscreen: false
  };

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win
let settingsWin

var shouldQuit = app.makeSingleInstance(function(){
  if(win){
    if(win.isMinimized()) win.restore();
    win.focus();
  }
});

if(shouldQuit){
  app.quit();
  return;
}

autoUpdater.on("update-downloaded", function(ev, info){
  dialog.showMessageBox(win, {type: "info", buttons: ["No", "Yes"], defaultId: 1, title:"Update Downloaded", message: "An update has been downloaded. Restart Film Reel to install it. Restart now?", cancelId: 0}, function(response){
    if(response === 1){
      autoUpdater.quitAndInstall();
    }
  })
});

function createWindow () {
  // Create the browser window.
  win = new BrowserWindow({
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icons", "icon.png"),
    backgroundColor: "#fff",
    show: false
  })
  torrents = resume(win);

  if(storeConfig.get("updates").value){
    autoUpdater.checkForUpdates();
  }

  var appMenuTemplate = [
    {
      label: "Film Reel",
      submenu: [
        {
          label: "About Film Reel",
          click: function(){require('electron').shell.openExternal("https://filmreelapp.com")}
        },
        {
          type: "separator"
        },
        {
          role: "quit"
        }
      ]
    },
    {
      label: "Controls",
      submenu: [
        {
          enabled: false,
          label: "Play/Pause",
          click: function(){
            setThumbar(null)
            win.webContents.send("playback", null)
          }
        },
        {
          enabled: false,
          label: "Volume",
          submenu: [
            {
              label: "0%",
              click: function(){
                win.webContents.send("volume", {volume: 0, update: true});
              }
            },
            {
              label: "25%",
              click: function(){
                win.webContents.send("volume", {volume: 0.25, update: true});
              }
            },
            {
              label: "50%",
              click: function(){
                win.webContents.send("volume", {volume: 0.5, update: true});
              }
            },
            {
              label: "100%",
              click: function(){
                win.webContents.send("volume", {volume: 1, update: true});
              }
            }
          ]
        },
        {
          enabled: false,
          label: "Toggle Full Screen",
          click: function(){
            win.setFullScreen(!current.fullscreen);
            current.fullscreen = !current.fullscreen;
            win.webContents.send("fullscreen", null)
          }
        }
      ]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Report Issue",
          click: function(){require('electron').shell.openExternal("https://github.com/kirpal/filmreel/issues")}
        },
        {
          label: "View Source Code (GitHub)",
          click: function(){require('electron').shell.openExternal("https://github.com/kirpal/filmreel")}
        },
        {
          type: "separator"
        },
        {
          label: "Check For Updates",
          click: function(){autoUpdater.checkForUpdates()}
        }
      ]
    }
  ];
  var appMenu = Menu.buildFromTemplate(appMenuTemplate);
  Menu.setApplicationMenu(appMenu)

  // and load the index.html of the app.
  win.loadURL(`file://${__dirname}/index.html`)
  win.once('ready-to-show', function(){
    win.show();
  });

  win.webContents.on('new-window', function(e, url) {
    e.preventDefault();
    require('electron').shell.openExternal(url);
  });

  // Emitted when the window is closed.
  win.on('closed', () => {
    //stop all torrents
    Object.keys(torrents).forEach(function(id){
      torrents[id].end();
      delete torrents[id]
    });
    //dereference window object
    win = null
  })

  //get data for the browsing page's windows
  ipcMain.on("getPage", function(event, page){
    if(page === "home"){
      //get template markdown file from server
      request("https://filmreelapp.com/home.md", function(error, response, body){
        if(!error && response.statusCode == 200){
          fs.writeFileSync(path.join(app.getPath("userData"), "home.md"), body);
        }
      });
      //get template markdown from file
      var homeTemplate;
      if(storeProgress.getRecent().length > 0){
        var recentMovies = "{{" + storeProgress.getRecent().join("}}{{") + "}}";
      }else{
        var recentMovies = "";
      }
      try{
        homeTemplate = fs.readFileSync(path.join(app.getPath("userData"), "home.md"), "utf8").replace(/\{\{RECENT\}\}/g, recentMovies);
      }catch(err){
        if(err.code === "ENOENT"){
          homeTemplate = "# Recent\n\n" + recentMovies;
        }
      }
      event.returnValue = homeTemplate;
    }else if(page === "library"){
      //get torrents
      store.reload();
      event.returnValue = store.get();
    }
  })

  ipcMain.on("getVersion", function(event){
    event.returnValue = app.getVersion();
  })
  ipcMain.on("getConfig", function(event){
    event.returnValue = storeConfig.getAll();
  })
  ipcMain.on("storeConfig", function(event, config){
    if(Object.keys(storeConfig.getAll()).indexOf(config.setting) !== -1){
      if(storeConfig.get(config.setting).type === "text"){
        if(typeof config.value === "string"){
          storeConfig.store(config.setting, "value", config.value);
          event.returnValue = {success: true, stored: config.value};
        }else{
          event.returnValue = {success: false, stored: storeConfig.get(config.setting).value};
        }
      }else if(storeConfig.get(config.setting).type === "number"){
        if(typeof parseInt(config.value) === "number"){
          storeConfig.store(config.setting, "value", config.value);
          event.returnValue = {success: true, stored: config.value};
        }else{
          event.returnValue = {success: false, stored: storeConfig.get(config.setting).value};
        }
      }else if(storeConfig.get(config.setting).type === "directory"){
        try{
          fs.accessSync(config.value, fs.constants.R_OK | fs.constants.W_OK);
          var access = true;
        }catch(err){
          var access = false;
        }
        if(fs.existsSync(config.value) && access){
          storeConfig.store(config.setting, "value", config.value);
          event.returnValue = {success: true, stored: config.value};
        }else{
          event.returnValue = {success: false, stored: storeConfig.get(config.setting).value};
        }
      }else if(storeConfig.get(config.setting).type === "boolean"){
        if(typeof config.value === "boolean"){
          storeConfig.store(config.setting, "value", config.value);
          event.returnValue = {success: true, stored: config.value};
        }else{
          event.returnValue = {success: false, stored: storeConfig.get(config.setting).value};
        }
      }
    }
  })

  function setThumbar(state){
    if(state){
      win.setThumbarButtons([
        {
          tooltip: "Pause",
          icon: path.join(__dirname, "icons", "thumbar-pause.png"),
          click(){
            setThumbar(false);
            win.webContents.send("playback", false);
          }
        }
      ])
    }else{
      win.setThumbarButtons([
        {
          tooltip: "Play",
          icon: path.join(__dirname, "icons", "thumbar-play.png"),
          click(){
            setThumbar(true);
            win.webContents.send("playback", true);
          }
        }
      ])
    }
  }
  ipcMain.on('stream', function(event, movie){
    //movie is already downloaded
    var downloaded = (store.get().complete.indexOf(movie.id.toString()) !== -1);
    //when play button is clicked on a movie
    if(!torrents[movie.id] && !downloaded){
      torrents[movie.id] = torrent(movie, false, win);
    }
    win.loadURL(`file://${__dirname}/player/index.html`);
    appMenu.items[1].submenu.items[0].enabled = true;
    appMenu.items[1].submenu.items[1].enabled = true;
    appMenu.items[1].submenu.items[2].enabled = true;
    current.movie = movie;

    ipcMain.on("exitStreaming", function(event){
      win.setFullScreen(false);
      ipcMain.removeAllListeners("playMovie");
      ipcMain.removeAllListeners("metadata");
      ipcMain.removeAllListeners("playback");
      ipcMain.removeAllListeners("volume");
      ipcMain.removeAllListeners("progress");
      ipcMain.removeAllListeners("fullscreen");
      ipcMain.removeAllListeners("exitStreaming");
      win.loadURL(`file://${__dirname}/index.html`);
      appMenu.items[1].submenu.items[0].enabled = false;
      appMenu.items[1].submenu.items[1].enabled = false;
      appMenu.items[1].submenu.items[2].enabled = false;
      win.setThumbarButtons([]);
      if(!downloaded && !torrents[movie.id].download){
        torrents[movie.id].end();
        delete torrents[movie.id]
      }
    })

    //sent to get the movie object
    ipcMain.on("playMovie", function(event){
      //respond with movie object and streaming port once torrent is ready
      if(!downloaded){
        torrents[movie.id].on("ready", function(){
          event.sender.send("playMovie", movie)
          event.sender.send("streamPort", streamPort)
        })
      }else{
        event.sender.send("playMovie", movie)
        event.sender.send("streamPort", streamPort)
      }
    });
    //when metadata for video is loaded
    ipcMain.on("metadata", function(event, duration){
      //send starting values
      current.volume = 0.75;
      current.progress = (typeof storeProgress.get(movie.id) === 'undefined') ? 0 : storeProgress.get(movie.id) * duration;
      current.duration = duration;
      current.playing = true;
      event.sender.send("volume", {volume: current.volume, update: true})
      event.sender.send("progress", {progress: current.progress, total: current.duration, update: true})
      event.sender.send("playback", true)

      ipcMain.on('playback', function(event, state){
        //play/pause
        setThumbar(state)
        current.playing = (state === null) ? !current.playing : state;
        event.sender.send("playback", state)
      })
      ipcMain.on('volume', function(event, data){
        //set volume
        current.volume = data.volume;
        event.sender.send("volume", data)
      })
      ipcMain.on('progress', function(event, data){
        //movie progress
        //store progress in progress.json
        storeProgress.store(data.progress, data.total, data.id);
        current.progress = data.progress;
        current.duration = data.total;
        event.sender.send("progress", data);
      })
      ipcMain.on("fullscreen", function(event, state){
        //change fullscreen state
        var setState = (state === null) ? !current.fullscreen : state;
        current.fullscreen = setState;
        win.setFullScreen(setState);
        event.sender.send("fullscreen", state);
      })
    })
  })
  ipcMain.on('download', function(event, movie){
    //when download button on movie is pressed
    if(torrents[movie.id] && !torrents[movie.id].download){
      torrents[movie.id].end()
    }
    if(store.get().complete.indexOf(movie.id.toString()) === -1){
      torrents[movie.id] = torrent(movie, true, win, (Object.keys(torrents).filter(function(id){return torrents[id].download}).length >= 1));
    }
  })
  ipcMain.on('delete', function(event, movie){
    //when delete button on movie is pressed
    if(torrents[movie.id]){
      torrents[movie.id].end()
    }
    if(store.get().complete.indexOf(movie.id.toString()) !== -1){
      store.remove(movie.id);
    }
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
  var state = (req.body.state === "play") ? true : (req.body.state === "pause") ? false : null;
  setThumbar(state)
  win.webContents.send("playback", state)
})
api.post('/volume/', function(req, res){
  var update = (typeof req.body.update === "undefined") ? true : update;
  var data = {volume: req.body.volume, update: update};
  win.webContents.send("volume", data)
})
api.post('/progress/', function(req, res){
  var update = (typeof req.body.update === "undefined") ? true : update;
  var data = {progress: req.body.progress, total: req.body.total, update: update};
  win.webContents.send("progress", data)
})
api.post('/fullscreen/', function(req, res){
  var state = (req.body.state === "enter") ? true : (req.body.state === "exit") ? false : null;
  var setState = (state === null) ? !current.fullscreen : state;
  current.fullscreen = setState;
  win.setFullScreen(setState);
  win.webContents.send("fullscreen", state)
})
api.get('/current/', function(req, res){
  res.json(current);
})

api.all('/stream/:id', function (req, res) {
  if(store.get().complete.indexOf(req.params.id) !== -1){
    var file = {
      name: req.params.id + "." + store.getFormat(req.params.id),
      path: path.join(libraryLocation, req.params.id + "." + store.getFormat(req.params.id)),
      length: fs.statSync(path.join(libraryLocation, req.params.id + "." + store.getFormat(req.params.id))).size
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
