"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ffmpegPath = require("ffmpeg-static");

const app = express();

const PORT = process.env.PORT || 10000;

const ROOT = __dirname;

const PUBLIC_DIR =
  path.join(ROOT, "public");

const TEMP_DIR =
  path.join(os.tmpdir(), "uniq-pro");

fs.mkdirSync(TEMP_DIR, {
  recursive: true
});

const jobs = new Map();

/*
=========================================================
CONFIG
=========================================================
*/

const MAX_FILE_SIZE =
  500 * 1024 * 1024;

const JOB_TTL =
  60 * 60 * 1000;


/*
=========================================================
EXPRESS
=========================================================
*/

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(PUBLIC_DIR)
);


/*
=========================================================
MULTER
=========================================================
*/

const storage =
  multer.diskStorage({

    destination:
      (req,file,cb) => {

        cb(
          null,
          TEMP_DIR
        );
      },

    filename:
      (req,file,cb) => {

        const id =
          crypto.randomBytes(16)
            .toString("hex");

        const ext =
          path.extname(
            file.originalname
          ) || ".video";

        cb(
          null,
          `${id}${ext}`
        );
      }
  });

const upload =
  multer({

    storage,

    limits:{
      fileSize:
        MAX_FILE_SIZE
    },

    fileFilter:
      (req,file,cb) => {

        const allowed =
          [
            "video/mp4",
            "video/quicktime",
            "video/webm",
            "video/x-m4v"
          ];

        const ext =
          /\.(mp4|mov|m4v|webm)$/i
            .test(file.originalname);

        if(
          allowed.includes(file.mimetype) ||
          ext
        ){

          cb(null,true);

        }else{

          cb(
            new Error(
              "Неподдерживаемый формат видео."
            )
          );
        }
      }
  });


/*
=========================================================
HELPERS
=========================================================
*/

function randomName(){

  return crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase();
}


function safeName(name){

  return String(name)
    .replace(/[^a-zA-Z0-9._-]/g,"_")
    .slice(0,80);
}


function clamp(value,min,max){

  return Math.max(
    min,
    Math.min(max,value)
  );
}


function formatDimensions(format){

  const formats={

    "9:16":[1080,1920],

    "4:5":[1080,1350],

    "1:1":[1080,1080],

    "16:9":[1920,1080]
  };

  return (
    formats[format] ||
    formats["9:16"]
  );
}


function getBitrate(
  width,
  height,
  enhance
){

  const pixels=
    width*height;

  let bitrate;

  if(
    pixels >=
    1920*1080
  ){

    bitrate=14000000;

  }else if(
    pixels >=
    1080*1350
  ){

    bitrate=11000000;

  }else{

    bitrate=9000000;
  }

  if(enhance==="high"){

    bitrate*=1.15;

  }

  return Math.round(bitrate);
}


function getDuration(
  input
){

  return new Promise(
    (resolve,reject)=>{

      const probe=
        spawn(
          ffmpegPath,
          [
            "-i",
            input
          ]
        );

      let output="";

      probe.stderr.on(
        "data",
        data=>{
          output+=data.toString();
        }
      );

      probe.on(
        "close",
        ()=>{
          
          const match=
            output.match(
              /Duration:\s*(\d+):(\d+):([\d.]+)/
            );

          if(!match){

            resolve(null);

            return;
          }

          const h=
            Number(match[1]);

          const m=
            Number(match[2]);

          const s=
            Number(match[3]);

          resolve(
            h*3600+
            m*60+
            s
          );
        }
      );

      probe.on(
        "error",
        reject
      );
    }
  );
}


/*
=========================================================
FFMPEG FILTER
=========================================================
*/

function buildVideoFilter(settings){

  const format =
    settings.format || "9:16";

  const fit =
    settings.fit || "smart";

  const level =
    Number(settings.level || 2);

  const enhance =
    settings.enhance || "off";

  const mirror =
    Boolean(settings.mirror);

  const [
    width,
    height
  ] =
    formatDimensions(format);

  let filters=[];


  /*
  MIRROR
  */

  if(mirror){

    filters.push(
      "hflip"
    );
  }


  /*
  ENHANCEMENT
  */

  if(enhance==="standard"){

    /*
      Light denoise + sharpening.
    */

    filters.push(
      "hqdn3d=1.2:1.2:6:6"
    );

    filters.push(
      "unsharp=5:5:0.65:5:5:0"
    );
  }


  if(enhance==="high"){

    /*
      Stronger denoise.
    */

    filters.push(
      "hqdn3d=2:2:8:8"
    );

    /*
      Moderate sharpening.
    */

    filters.push(
      "unsharp=7:7:0.9:7:7:0"
    );
  }


  /*
  FORMAT
  */

  if(fit==="blur"){

    /*
      Blurred background + centered
      original video.
    */

    const bg =
      `scale=${width}:${height}:force_original_aspect_ratio=increase,`+
      `crop=${width}:${height},`+
      `gblur=sigma=28`;

    const fg =
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`;

    filters.push(
      `split=2[bg][fg];`+
      `[bg]${bg}[blur];`+
      `[fg]${fg}[main];`+
      `[blur][main]overlay=(W-w)/2:(H-h)/2`
    );

  }else{

    /*
      Smart and Fill use crop-to-fill.
    */

    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=increase`
    );

    filters.push(
      `crop=${width}:${height}`
    );
  }


  /*
  LIGHT UNIQUE TRANSFORM
  */

  if(level>=2){

    const zoom=
      level===2
        ? "1.008"
        : "1.014";

    /*
      Small crop adjustment.
      This is intentionally subtle.
    */

    filters.push(
      `scale=iw*${zoom}:ih*${zoom}`
    );

    filters.push(
      `crop=${width}:${height}`
    );
  }


  /*
  Final pixel format.
  */

  filters.push(
    "format=yuv420p"
  );


  return filters.join(",");
}


/*
=========================================================
RUN FFMPEG
=========================================================
*/

async function processJob(job){

  const input=
    job.input;

  const output=
    job.output;

  try{

    job.status="processing";

    job.message=
      "Подготовка FFmpeg…";

    job.progress=0;


    const duration=
      await getDuration(input);


    job.duration=
      duration || 0;


    const [
      width,
      height
    ] =
      formatDimensions(
        job.settings.format
      );


    const bitrate=
      getBitrate(
        width,
        height,
        job.settings.enhance
      );


    const filter=
      buildVideoFilter(
        job.settings
      );


    /*
      We use libx264 because the
      result needs to be compatible
      with iPhone/iPad.
    */

    const args=[

      "-y",

      "-i",
      input,

      "-vf",
      filter,

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      job.settings.enhance==="high"
        ? "19"
        : "20",

      "-b:v",
      String(bitrate),

      "-maxrate",
      String(Math.round(bitrate*1.25)),

      "-bufsize",
      String(Math.round(bitrate*2)),

      "-r",
      "30",

      "-c:a",
      "aac",

      "-b:a",
      "192k",

      "-ar",
      "48000",

      "-movflags",
      "+faststart",

      "-progress",
      "pipe:1",

      "-nostats",

      output
    ];


    job.message=
      "Обработка видео…";


    const ffmpeg=
      spawn(
        ffmpegPath,
        args,
        {
          windowsHide:true
        }
      );


    job.process=
      ffmpeg;


    let stderr="";


    ffmpeg.stdout.on(
      "data",
      data=>{

        const text=
          data.toString();

        const matches=
          text.match(
            /out_time_ms=(\d+)/g
          );

        if(
          matches &&
          matches.length
        ){

          const last=
            matches[matches.length-1];

          const ms=
            Number(
              last.split("=")[1]
            );

          const current=
            ms/1000000;

          if(duration){

            job.progress=
              clamp(
                current/duration*100,
                0,
                99
              );
          }
        }
      }
    );


    ffmpeg.stderr.on(
      "data",
      data=>{

        stderr+=data.toString();

        /*
          FFmpeg can output lots of
          diagnostics. Keep only the
          last part in memory.
        */

        if(stderr.length>20000){

          stderr=
            stderr.slice(-20000);
        }
      }
    );


    await new Promise(
      (resolve,reject)=>{

        ffmpeg.on(
          "error",
          reject
        );

        ffmpeg.on(
          "close",
          code=>{

            if(code===0){

              resolve();

            }else{

              reject(
                new Error(
                  `FFmpeg завершился с кодом ${code}\n\n`+
                  stderr.slice(-3000)
                )
              );
            }
          }
        );
      }
    );


    if(
      !fs.existsSync(output)
    ){

      throw new Error(
        "FFmpeg не создал выходной файл."
      );
    }


    const stat=
      fs.statSync(output);


    if(stat.size===0){

      throw new Error(
        "Получен пустой выходной файл."
      );
    }


    job.status="done";

    job.progress=100;

    job.message="Готово";

    job.outputName=
      `${safeName(
        job.baseName
      )}_${randomName()}.mp4`;

    job.downloadUrl=
      `/api/jobs/${job.id}/download`;

  }catch(error){

    job.status="error";

    job.message="Ошибка";

    job.error=
      error.message ||
      "Неизвестная ошибка";

  }finally{

    /*
      Input can be deleted immediately
      after processing.

      Output stays until TTL cleanup.
    */

    try{

      if(
        fs.existsSync(input)
      ){

        fs.unlinkSync(input);
      }

    }catch{}

    delete job.process;
  }
}


/*
=========================================================
CREATE JOB
=========================================================
*/

app.post(
  "/api/jobs",
  upload.single("video"),
  async(req,res)=>{

    if(!req.file){

      return res
        .status(400)
        .json({
          error:"Видео не загружено."
        });
    }


    let settings={};

    try{

      settings=
        JSON.parse(
          req.body.settings || "{}"
        );

    }catch{

      settings={};
    }


    const validFormats=
      [
        "9:16",
        "4:5",
        "1:1",
        "16:9"
      ];


    const validFits=
      [
        "smart",
        "fill",
        "blur"
      ];


    const validEnhance=
      [
        "off",
        "standard",
        "high"
      ];


    settings.format=
      validFormats.includes(
        settings.format
      )
        ? settings.format
        : "9:16";


    settings.fit=
      validFits.includes(
        settings.fit
      )
        ? settings.fit
        : "smart";


    settings.level=
      clamp(
        Number(settings.level || 2),
        1,
        3
      );


    settings.mirror=
      Boolean(settings.mirror);


    settings.enhance=
      validEnhance.includes(
        settings.enhance
      )
        ? settings.enhance
        : "off";


    const id=
      crypto
        .randomBytes(12)
        .toString("hex");


    const extension=
      ".mp4";


    const output=
      path.join(
        TEMP_DIR,
        `${id}_output${extension}`
      );


    const job={

      id,

      status:"queued",

      progress:0,

      message:"Очередь…",

      error:null,

      input:req.file.path,

      output,

      originalName:req.file.originalname,

      baseName:
        path.basename(
          req.file.originalname,
          path.extname(
            req.file.originalname
          )
        ),

      settings,

      createdAt:Date.now(),

      outputName:null,

      downloadUrl:null
    };


    jobs.set(
      id,
      job
    );


    /*
      Start asynchronously.
    */

    processJob(job)
      .catch(error=>{

        job.status="error";

        job.error=
          error.message;
      });


    res.json({
      jobId:id,
      status:"queued"
    });
  }
);


/*
=========================================================
JOB STATUS
=========================================================
*/

app.get(
  "/api/jobs/:id",
  (req,res)=>{

    const job=
      jobs.get(
        req.params.id
      );


    if(!job){

      return res
        .status(404)
        .json({
          error:"Job не найден."
        });
    }


    res.json({

      id:job.id,

      status:job.status,

      progress:
        Math.round(
          job.progress || 0
        ),

      message:
        job.message,

      error:
        job.error,

      outputName:
        job.outputName,

      downloadUrl:
        job.downloadUrl
    });
  }
);


/*
=========================================================
DOWNLOAD
=========================================================
*/

app.get(
  "/api/jobs/:id/download",
  (req,res)=>{

    const job=
      jobs.get(
        req.params.id
      );


    if(!job){

      return res
        .status(404)
        .json({
          error:"Job не найден."
        });
    }


    if(job.status!=="done"){

      return res
        .status(409)
        .json({
          error:
            "Видео ещё обрабатывается."
        });
    }


    if(
      !fs.existsSync(
        job.output
      )
    ){

      return res
        .status(404)
        .json({
          error:
            "Готовый файл больше недоступен."
        });
    }


    res.download(
      job.output,
      job.outputName ||
      "uniq-pro-video.mp4"
    );
  }
);


/*
=========================================================
HEALTH
=========================================================
*/

app.get(
  "/api/health",
  (req,res)=>{

    res.json({
      ok:true,
      service:"uniq-pro",
      ffmpeg:Boolean(ffmpegPath)
    });
  }
);


/*
=========================================================
ERROR HANDLER
=========================================================
*/

app.use(
  (error,req,res,next)=>{

    console.error(error);

    if(
      error instanceof multer.MulterError
    ){

      if(
        error.code==="LIMIT_FILE_SIZE"
      ){

        return res
          .status(413)
          .json({
            error:
              "Видео слишком большое. Максимум 500 MB."
          });
      }
    }


    res
      .status(400)
      .json({
        error:
          error.message ||
          "Ошибка сервера."
      });
  }
);


/*
=========================================================
CLEANUP
=========================================================
*/

setInterval(
  ()=>{

    const now=Date.now();

    for(
      const [id,job]
      of jobs.entries()
    ){

      if(
        now-job.createdAt >
        JOB_TTL
      ){

        try{

          if(
            fs.existsSync(job.input)
          ){

            fs.unlinkSync(
              job.input
            );
          }

        }catch{}


        try{

          if(
            fs.existsSync(job.output)
          ){

            fs.unlinkSync(
              job.output
            );
          }

        }catch{}


        jobs.delete(id);
      }
    }

  },
  10*60*1000
);


/*
=========================================================
START
=========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  ()=>{
    console.log(
      `Uniq Pro running on port ${PORT}`
    );

    console.log(
      `FFmpeg: ${ffmpegPath}`
    );
  }
);
