const express = require("express");
const app = express();
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();
const stripe = require("stripe")(`${process.env.PAY_GATE_KEY}`);
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const verifyToken = (req, res, next) => {
  const authorization = req.headers.authorization;
  console.log(authorization);
  if (!authorization) {
    return res
      .status(401)
      .send({ error: true, message: "unauthorized access" });
  }

  const browserToken = authorization.split(" ")[1];
  if (!browserToken) {
    return res.status(401).send({
      error: true,
      message: "Authorization Token Not Found",
    });
  }

  jwt.verify(
    browserToken,
    process.env.SECRET_KEY,
    (err, decodedToken) => {
      if (err) {
        return res
          .status(403)
          .send({ error: true, message: "Forbidden" });
      }

      req.decodedToken = decodedToken;
      console.log("verify token success");
      next();
    }
  );
};
const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
} = require("mongodb");
const uri = `mongodb+srv://${process.env.AX_DB_USER}:${process.env.AX_DB_PASSWORD}@cluster0.uhjduzi.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server
    await client.connect(() => {
      console.log("mongo");
    });

    const usersCollection = client
      .db(`${process.env.AX_DB_NAME}`)
      .collection("users");
    const classesCollection = client
      .db(`${process.env.AX_DB_NAME}`)
      .collection("classes");
    const bookedClassesCollection = client
      .db(`${process.env.AX_DB_NAME}`)
      .collection("bookedClasses");
    const paymentCollection = client
      .db(`${process.env.AX_DB_NAME}`)
      .collection("payment");

    app.post("/token-generator", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.SECRET_KEY, {
        expiresIn: "1h",
      });
      return res
        .status(200)
        .send({ message: "Token Created successfully", token });
    });
    app.get(
      "/enrolled/courses/:email",
      verifyToken,
      async (req, res) => {
        const userEmail = req.params.email;
        try {
          const payments = await paymentCollection
            .find({ email: userEmail })
            .toArray();

          const enrolledCourses = [];

          for (const payment of payments) {
            const classInfo = await classesCollection.findOne({
              _id: new ObjectId(payment.classId),
            });
            console.log("classnifo", classInfo);

            const enrolledCourse = {
              _id: payment._id,
              email: payment.email,
              transactionId: payment.transactionId,
              price: payment.price,
              date: payment.date,
              className: classInfo.courseName,
              instructorName: classInfo.instructorName,
              status: "paid",
            };

            enrolledCourses.push(enrolledCourse);
          }

          return res.send({ message: "data found", enrolledCourses });
        } catch (error) {
          console.error(error);
          return res
            .status(500)
            .send({ message: "Internal server error" });
        }
      }
    );

    app.post(
      "/create-payment-intent",
      verifyToken,
      async (req, res) => {
        const { price } = req.body;
        const amount = price * 100;
        console.log(price, amount);

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount,
          currency: "usd",
          payment_method_types: ["card"],
        });

        return res.send({
          clientSecret: paymentIntent.client_secret,
        });
      }
    );

    app.post("/payment", verifyToken, async (req, res) => {
      const payment = req.body;
      const result = await paymentCollection.insertOne(payment);
      console.log(payment);
      const deleteBookedClass =
        await bookedClassesCollection.deleteOne({
          _id: new ObjectId(payment.selectedClassId),
        });

      const updateEnrolledStudent = await classesCollection.updateOne(
        { _id: new ObjectId(payment.classId) },
        { $inc: { enrolledStudent: 1 } }
      );
      return res.status(200).send({
        message: "Successfully stored",
        result,
        deleteBookedClass,
        updateEnrolledStudent,
      });
    });

    app.post("/booked/class", verifyToken, async (req, res) => {
      const { bookedData } = req.body;

      try {
        const searchClassQuery = {
          _id: new ObjectId(bookedData.classId),
        };
        const selectedClass = await classesCollection.findOne(
          searchClassQuery
        );

        if (!selectedClass) {
          return res.status(404).json({ error: "Class not found" });
        }

        if (selectedClass.seats <= 0) {
          return res
            .status(400)
            .json({ error: "No available seats" });
        }

        selectedClass.seats -= 1;
        const updateSeats = { $set: selectedClass };

        await classesCollection.updateOne(
          searchClassQuery,
          updateSeats
        );

        const newBookedClass = {
          studentEmail: bookedData.studentEmail,
          classId: bookedData.classId,
          status: "Booked",
        };

        const bookedClass = await bookedClassesCollection.insertOne(
          newBookedClass
        );

        return res.status(200).json({
          message: "Class booked successfully",
          bookedClass,
        });
      } catch (error) {
        console.error("Error booking class:", error);
        return res
          .status(500)
          .json({ error: "Internal server error" });
      }
    });

    app.get("/user/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      console.log(req.decodedToken.email);
      if (email != req.decodedToken.email) {
        return res.status(401).send({
          error: true,
          message: "Unauthorized",
        });
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query);

      if (!user) {
        return res.status(404).send({
          error: true,
          message: "User not found",
        });
      }

      let result = {};

      if (user.role === "admin") {
        result.admin = true;
      } else if (user.role === "instructor") {
        result.instructor = true;
      } else if (user.role === "student") {
        result.student = true;
      }

      return res.status(200).send({
        message: `User role retrieved successfully`,
        result: result,
      });
    });

    const checkAdmin = async (req, res, next) => {
      const email = req.decodedToken.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user?.role !== "admin") {
        return res.status(403).send({ error: "forbidden" });
      }

      next();
    };

    const checkInstructor = async (req, res, next) => {
      const email = req.decodedToken.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);

      if (user?.role !== "instructor") {
        return res.status(403).send({ error: "forbidden" });
      }
      console.log(" instructor verification successfull");
      next();
    };

    app.get(
      "/get-users",
      verifyToken,
      checkAdmin,
      async (req, res) => {
        try {
          const userData = await usersCollection.find().toArray();
          return res.status(200).send({
            message: "user data found successfully",
            userData,
          });
        } catch (error) {
          return res.status(500).send({
            error: "Internal Server Error",
          });
        }
      }
    );

    app.patch(
      "/user/role/:id",
      verifyToken,
      checkAdmin,
      async (req, res) => {
        const userId = req.params.id;
        const { role } = req.body;

        try {
          const query = { _id: new ObjectId(userId) };
          const updateInfo = {
            $set: {
              role: role,
            },
          };
          const updatedUser = await usersCollection.updateOne(
            query,
            updateInfo
          );
          return res.status(200).send({
            message: ` Succesfully Updated Role : ${role}`,
            updatedUser,
          });
        } catch (error) {
          return res.status(500).send({
            error: "Internal Server Error",
          });
        }
      }
    );

    app.get(
      "/all-classes",
      verifyToken,
      checkAdmin,
      async (req, res) => {
        try {
          const classesData = await classesCollection
            .find()
            .toArray();
          return res.status(200).send({
            message: "classes data found successfully",
            classesData,
          });
        } catch (error) {
          return res.status(500).json({
            error: "Internal Server Error",
          });
        }
      }
    );

    app.patch(
      "/class/status/:id",
      verifyToken,
      checkAdmin,
      async (req, res) => {
        const classId = req.params.id;
        const { status } = req.body;
        try {
          const query = { _id: new ObjectId(classId) };
          const updateInfo = {
            $set: {
              status: status,
            },
          };
          const updatedStatus = await classesCollection.updateOne(
            query,
            updateInfo
          );
          console.log(updatedStatus);
          return res.status(200).send({
            message: ` Succesfully Updated Class Status ${status}`,
            updatedStatus,
          });
        } catch (error) {
          return res.status(500).json({
            error: "Internal Server Error",
          });
        }
      }
    );
    app.patch(
      "/classes/feedback/:classId",
      verifyToken,
      checkAdmin,
      async (req, res) => {
        const classId = req.params.classId;
        const feedback = req.body.feedback;
        console.log(classId, feedback);
        try {
          const query = { _id: ObjectId(classId) };
          const updateFeedback = {
            $set: { feedback: feedback },
          };
          const result = await classesCollection.updateOne(
            query,
            updateFeedback
          );
          if (result.modifiedCount === 1) {
            return res
              .status(200)
              .json({ message: "Feedback updated successfully." });
          } else {
            return res
              .status(404)
              .json({ message: "Class not found." });
          }
        } catch (error) {
          console.error(error);
          res.status(500).json({ message: "Internal server error." });
        }
      }
    );

    app.post(
      "/instructor/add/class",
      verifyToken,
      checkInstructor,
      async (req, res) => {
        const classData = req.body;
        try {
          classData.status = "pending";
          classData.enrolledStudent = 0;
          const result = await classesCollection.insertOne(classData);
          return res.status(200).send({
            message: "Class Information Inserted successfully",
            result,
          });
        } catch (error) {
          return res.status(500).json({
            error: "Internal Server Error",
          });
        }
      }
    );

    app.get(
      "/instructor/classes/:email",
      verifyToken,
      checkInstructor,
      async (req, res) => {
        try {
          const email = req.params.email;

          const query = { instructorEmail: email };

          const classes = await classesCollection
            .find(query)
            .toArray();

          return res.status(200).json({ classesData: classes });
        } catch (error) {
          return res
            .status(500)
            .json({ error: "Internal server error" });
        }
      }
    );

    app.post("/create-user", async (req, res) => {
      const userData = req.body;

      try {
        const existingEmail = { email: userData.email };
        const existingUser = await usersCollection.findOne(
          existingEmail
        );

        if (existingUser) {
          return res
            .status(400)
            .send({ message: "User Already Exist" });
        }
        userData.role = "student";
        const result = await usersCollection.insertOne(userData);
        return res.status(200).send({
          message: "User Information Inserted successfully",
          result,
        });
      } catch (error) {
        return res.status(500).send({
          error: "Internal Server Error",
        });
      }
    });
    app.get("/popular/instructors", async (req, res) => {
      try {
        const query = { role: "instructor" };
        const userData = await usersCollection
          .find(query)
          .limit(6)
          .toArray();
        return res.status(200).send({
          message: "Popular Instructors data found successfully",
          userData,
        });
      } catch (error) {
        return res.status(500).json({
          error: "Internal Server Error",
        });
      }
    });
    app.get("/all/instructors", async (req, res) => {
      try {
        const query = { role: "instructor" };
        const userData = await usersCollection.find(query).toArray();
        return res.status(200).send({
          message: "Instructors data found successfully",
          userData,
        });
      } catch (error) {
        return res.status(500).json({
          error: "Internal Server Error",
        });
      }
    });
    app.get("/popular/classes", async (req, res) => {
      try {
        const classesData = await classesCollection
          .find()
          .sort({ enrolledStudent: -1 })
          .limit(6)
          .toArray();
        return res.status(200).send({
          message: "classes data found successfully",
          classesData,
        });
      } catch (error) {
        return res.status(500).json({
          error: "Internal Server Error",
        });
      }
    });

    app.get("/all/accepted/classes", async (req, res) => {
      try {
        const classesData = await classesCollection
          .find({ status: "accepted" })
          .toArray();

        return res.status(200).send({
          message: "Classes data found successfully",
          classesData,
        });
      } catch (error) {
        return res.status(500).json({
          error: "Internal Server Error",
        });
      }
    });

    app.get(
      "/student/selected/classes/:email",
      verifyToken,
      async (req, res) => {
        const email = req.params.email;

        try {
          const query = { studentEmail: email };

          const selectedClasses = await bookedClassesCollection
            .find(query)
            .toArray();

          const allClassId = selectedClasses.map(
            (selectedClass) => new ObjectId(selectedClass.classId)
          );

          const query2 = { _id: { $in: allClassId } };

          const classes = await classesCollection
            .find(query2)
            .toArray();

          const selectedClassesWithInfo = selectedClasses.map(
            (selectedClass) => {
              const classInfo = classes.find((cls) =>
                cls._id.equals(selectedClass.classId)
              );
              return {
                _id: selectedClass._id,
                classId: new ObjectId(classInfo._id),
                className: classInfo.courseName,
                instructorName: classInfo.instructorName,
                price: classInfo.price,
              };
            }
          );

          return res.status(200).json({
            message: "Selected classes retrieved successfully",
            selectedClasses: selectedClassesWithInfo,
          });
        } catch (error) {
          console.error("Error retrieving selected classes:", error);
          return res
            .status(500)
            .json({ error: "Internal server error" });
        }
      }
    );

    app.delete("/booked/class/:id", verifyToken, async (req, res) => {
      const bookedClassId = req.params.id;

      try {
        const query = { _id: ObjectId(bookedClassId) };
        const deletedClass =
          await bookedClassesCollection.findOneAndDelete(query);

        if (!deletedClass.value) {
          return res
            .status(404)
            .json({ error: "Booked class not found" });
        }

        const classId = deletedClass.value.classId;

        const updatedClass = await classesCollection.findOneAndUpdate(
          { _id: ObjectId(classId) },
          { $inc: { seats: 1 } },
          { returnOriginal: false }
        );

        if (!updatedClass.value) {
          return res.status(404).json({ error: "Class not found" });
        }

        return res
          .status(200)
          .json({ message: "Booked class deleted successfully" });
      } catch (error) {
        return res
          .status(500)
          .json({ error: "Internal server error" });
      }
    });

    app.put(
      "/instructor/class/update/:id",
      verifyToken,
      checkInstructor,
      async (req, res) => {
        console.log("i am here");
        const updateClassId = req.params.id;
        const updateClassInfo = req.body;
        console.log(updateClassId, updateClassInfo);

        try {
          const updatedClass =
            await classesCollection.findOneAndUpdate(
              { _id: ObjectId(updateClassId) },
              { $set: updateClassInfo },
              { returnOriginal: false }
            );

          if (!updatedClass) {
            return res.status(404).send({ error: "Class not found" });
          }

          return res.status(200).json({
            message: "Class info Updated successfully",
            updatedClass,
          });
        } catch (error) {
          console.error("Error updating class:", error);
          return res
            .status(500)
            .json({ error: "Internal server error" });
        }
      }
    );
  } finally {
    await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send({ message: "AdrenalineX server is running" });
});

//listens to port
app.listen(port, () => {
  console.log(`server is running on ${port}`);
});
